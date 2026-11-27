'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PERIODS = Object.freeze({ all: null, '24h': 24 * 60 * 60 * 1000, '1h': 60 * 60 * 1000, '15m': 15 * 60 * 1000 });
const TARGETS = new Set(['enquiries_and_alarms', 'all_reception_data', 'alarms_only']);
const ALLOWED_ROLES = new Set(['developer', 'administrator']);

function validateSelection(period, target) {
  if (!Object.hasOwn(PERIODS, period)) throw Object.assign(new Error('Invalid cleanup period.'), { code: 'CLEANUP_VALIDATION' });
  if (!TARGETS.has(target)) throw Object.assign(new Error('Invalid cleanup target.'), { code: 'CLEANUP_VALIDATION' });
}

function getWindow(period, now = new Date()) {
  if (!Object.hasOwn(PERIODS, period)) throw new Error('Invalid cleanup period.');
  const upper = new Date(now.getTime());
  const lower = PERIODS[period] === null ? null : new Date(upper.getTime() - PERIODS[period]);
  return { lowerUtc: lower?.toISOString() ?? null, upperUtc: upper.toISOString() };
}

function predicateFor(window) {
  if (!window.lowerUtc) return { sql: '1 = 1', params: [] };
  return { sql: 'datetime(e.created_at) >= datetime(?) AND datetime(e.created_at) <= datetime(?)', params: [window.lowerUtc, window.upperUtc] };
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName));
}

function readSelection(db, period, target, window) {
  const predicate = predicateFor(window);
  const enquiries = db.prepare(`SELECT e.* FROM enquiries e WHERE ${predicate.sql} ORDER BY e.id`).all(...predicate.params);
  const ids = enquiries.map(row => row.id);
  const alarms = ids.length
    ? db.prepare(`SELECT a.* FROM enquiry_alarms a WHERE a.enquiry_id IN (SELECT e.id FROM enquiries e WHERE ${predicate.sql}) ORDER BY a.id`).all(...predicate.params)
    : [];
  const webhookEvents = ids.length && tableExists(db, 'whatsapp_webhook_events')
    ? db.prepare(`SELECT w.* FROM whatsapp_webhook_events w WHERE w.enquiry_id IN (SELECT e.id FROM enquiries e WHERE ${predicate.sql}) ORDER BY w.event_id`).all(...predicate.params)
    : [];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ enquiries, alarms, webhookEvents })).digest('hex');
  return {
    ids,
    fingerprint,
    counts: {
      matchingEnquiries: enquiries.length,
      enquiries: target === 'alarms_only' ? 0 : enquiries.length,
      alarms: alarms.length,
      webhookEvents: webhookEvents.length
    }
  };
}

function createPrivateBackup(db, backupDir, now = new Date()) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(backupDir, 0o700); } catch (_) { /* best effort on platforms without chmod */ }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupDir, `pre-enquiry-cleanup-${stamp}-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  const escaped = file.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on platforms without chmod */ }
  return file;
}

function createCleanupOperations(db, writeAudit, options = {}) {
  const clock = options.clock || (() => new Date());
  const backup = options.backup || ((when) => createPrivateBackup(db, options.backupDir || path.join(__dirname, 'data', 'private-backups'), when));

  function preview(period, target) {
    validateSelection(period, target);
    const now = clock();
    const window = getWindow(period, now);
    const selected = readSelection(db, period, target, window);
    return {
      period, target, windowUtc: window,
      enquiries: selected.counts.enquiries,
      alarms: selected.counts.alarms,
      webhookEvents: selected.counts.webhookEvents,
      matchingEnquiries: selected.counts.matchingEnquiries,
      warning: target === 'alarms_only'
        ? 'Permanent deletion of alarm records linked to matching enquiries. Enquiries and WhatsApp webhook history will be retained.'
        : 'Permanent deletion of matching enquiries, linked alarm records, and linked WhatsApp webhook history. Registered devices and Firebase tokens are never selected or modified.'
    };
  }

  function execute({ period, target, confirmation, actor }) {
    validateSelection(period, target);
    if (confirmation !== 'CLEAR') throw Object.assign(new Error('Type CLEAR exactly to confirm this operation.'), { code: 'CLEANUP_VALIDATION' });
    if (!actor || !Number.isSafeInteger(Number(actor.id)) || !actor.username) throw Object.assign(new Error('Authenticated staff actor is required.'), { code: 'CLEANUP_VALIDATION' });

    const now = clock();
    const window = getWindow(period, now);
    const before = readSelection(db, period, target, window);
    const backupPath = backup(now); // Must finish before beginning any destructive operation.
    const backupName = path.basename(backupPath);
    const deleted = { enquiries: 0, alarms: 0, webhookEvents: 0 };

    const tx = db.transaction(() => {
      const current = readSelection(db, period, target, window);
      if (current.fingerprint !== before.fingerprint) {
        const stale = new Error('The selected records changed while the backup was being prepared. Review the data and retry.');
        stale.code = 'CLEANUP_SELECTION_CHANGED';
        throw stale;
      }
      const predicate = predicateFor(window);
      if (target !== 'alarms_only') {
        // Delete child history first: whatsapp_webhook_events intentionally has a restrictive FK.
        if (tableExists(db, 'whatsapp_webhook_events')) {
          const webhookResult = db.prepare(`DELETE FROM whatsapp_webhook_events WHERE enquiry_id IN (SELECT e.id FROM enquiries e WHERE ${predicate.sql})`).run(...predicate.params);
          deleted.webhookEvents = Number(webhookResult.changes || 0);
          if (deleted.webhookEvents !== before.counts.webhookEvents) throw new Error('WhatsApp webhook history deletion count did not match the verified selection.');
        }
        const alarmResult = db.prepare(`DELETE FROM enquiry_alarms WHERE enquiry_id IN (SELECT e.id FROM enquiries e WHERE ${predicate.sql})`).run(...predicate.params);
        deleted.alarms = Number(alarmResult.changes || 0);
        if (deleted.alarms !== before.counts.alarms) throw new Error('Alarm deletion count did not match the verified selection.');
        const result = db.prepare(`DELETE FROM enquiries AS e WHERE ${predicate.sql}`).run(...predicate.params);
        deleted.enquiries = Number(result.changes || 0);
        if (deleted.enquiries !== before.counts.matchingEnquiries) throw new Error('Enquiry deletion count did not match the verified selection.');
      } else {
        const result = db.prepare(`DELETE FROM enquiry_alarms WHERE enquiry_id IN (SELECT e.id FROM enquiries e WHERE ${predicate.sql})`).run(...predicate.params);
        deleted.alarms = Number(result.changes || 0);
        if (deleted.alarms !== before.counts.alarms) throw new Error('Alarm deletion count did not match the verified selection.');
      }
      writeAudit(Number(actor.id), 'enquiry.cleanup.executed', 'enquiry_cleanup', `${period}:${target}`, {
        actor_username: String(actor.username),
        period, target, windowUtc: window,
        matchingEnquiries: before.counts.matchingEnquiries,
        deletedEnquiries: deleted.enquiries,
        deletedAlarms: deleted.alarms,
        deletedWebhookEvents: deleted.webhookEvents,
        backup: backupName
      });
    });
    tx.immediate();
    return { success: true, period, target, deletedEnquiries: deleted.enquiries, deletedAlarms: deleted.alarms, deletedWebhookEvents: deleted.webhookEvents, matchingEnquiries: before.counts.matchingEnquiries, backupFile: backupName };
  }

  return { preview, execute };
}

function installEnquiryCleanup(app, db, requireAuth, writeAudit, options = {}) {
  const operations = createCleanupOperations(db, writeAudit, options);
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  const authorize = (req, res, next) => {
    if (!req.session?.staff) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!ALLOWED_ROLES.has(req.session.staff.role)) return res.status(403).json({ success: false, error: 'Insufficient permissions.' });
    next();
  };
  app.get('/api/admin/enquiry-cleanup/preview', requireAuth, noStore, authorize, (req, res) => {
    try {
      res.json({ success: true, ...operations.preview(req.query.period, req.query.target) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });
  app.post('/api/admin/enquiry-cleanup/execute', requireAuth, noStore, authorize, (req, res) => {
    try {
      res.json(operations.execute({ period: req.body?.period, target: req.body?.target, confirmation: req.body?.confirmation, actor: req.session.staff }));
    } catch (error) {
      const status = error.code === 'CLEANUP_SELECTION_CHANGED' ? 409 : error.code === 'CLEANUP_VALIDATION' ? 400 : 500;
      if (status >= 500) console.error('Enquiry cleanup failed:', error.message);
      res.status(status).json({ success: false, error: status >= 500 ? 'Cleanup failed safely; no partial deletion was committed.' : error.message });
    }
  });
  return operations;
}

module.exports = { PERIODS, TARGETS, ALLOWED_ROLES, validateSelection, getWindow, createPrivateBackup, createCleanupOperations, installEnquiryCleanup };
