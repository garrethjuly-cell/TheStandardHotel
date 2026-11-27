'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('../sqlite-adapter');
const { createCleanupOperations, createPrivateBackup, installEnquiryCleanup } = require('../enquiry-cleanup');

const FIXED_NOW = new Date('2026-11-17T10:00:00.000Z');
function fixture({ rows = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE staff (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO staff VALUES (1, 'admin'), (2, 'reception');
    CREATE TABLE enquiries (id INTEGER PRIMARY KEY, message TEXT, status TEXT, source TEXT, created_at TEXT, updated_at TEXT, acknowledged_at TEXT, acknowledged_by_staff_id INTEGER, acknowledged_by_username TEXT);
    CREATE TABLE enquiry_alarms (id INTEGER PRIMARY KEY, enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE, device_id TEXT NOT NULL, dismissed_at TEXT, dismissed_by_staff_id INTEGER, dismissed_by_username TEXT, created_at TEXT);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, reference TEXT); INSERT INTO bookings VALUES (1, 'KEEP-BOOKING');
    CREATE TABLE payment_transactions (reference TEXT PRIMARY KEY); INSERT INTO payment_transactions VALUES ('KEEP-PAYMENT');
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor_staff_id INTEGER, action TEXT, target_type TEXT, target_id TEXT, details_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  if (rows) {
    const ins = db.prepare('INSERT INTO enquiries (id,message,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?)');
    const dates = [
      ['now', '2026-11-17T10:00:00.000Z'],
      ['15m-edge', '2026-11-17T09:45:00.000Z'],
      ['1h-edge', '2026-11-17T09:00:00.000Z'],
      ['24h-edge', '2026-11-16T10:00:00.000Z'],
      ['older', '2026-11-15T10:00:00.000Z']
    ];
    for (let i = 0; i < dates.length; i++) ins.run(i + 1, dates[i][0], 'new', 'website', dates[i][1], dates[i][1]);
    const alarm = db.prepare('INSERT INTO enquiry_alarms (enquiry_id,device_id,created_at) VALUES (?,?,?)');
    for (let i = 1; i <= dates.length; i++) { alarm.run(i, `device-${i}-a`, '2026-11-17T10:00:00.000Z'); alarm.run(i, `device-${i}-b`, '2026-11-17T10:00:00.000Z'); }
  }
  const writeAudit = (...args) => db.prepare('INSERT INTO audit_log (actor_staff_id,action,target_type,target_id,details_json) VALUES (?,?,?,?,?)').run(args[0], args[1], args[2], String(args[3]), JSON.stringify(args[4]));
  return { db, writeAudit };
}
const testBackup = () => '/private/pre-cleanup-test.sqlite';

test('real pre-delete SQLite backup contains source rows and is private', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotel-cleanup-backup-'));
  const databasePath = path.join(dir, 'hotel.sqlite');
  const db = new Database(databasePath);
  db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved');");
  const backupPath = createPrivateBackup(db, path.join(dir, 'private'), FIXED_NOW);
  const stat = fs.statSync(backupPath);
  assert.equal(stat.mode & 0o777, 0o600);
  const backup = new Database(backupPath);
  assert.equal(backup.prepare('SELECT value FROM sample').get().value, 'preserved');
  backup.close();
  db.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('all four periods use UTC created_at cutoffs and exact boundary inclusivity', () => {
  const { db, writeAudit } = fixture();
  const cleanup = createCleanupOperations(db, writeAudit, { clock: () => FIXED_NOW, backup: testBackup });
  assert.equal(cleanup.preview('15m', 'alarms_only').matchingEnquiries, 2);
  assert.equal(cleanup.preview('1h', 'alarms_only').matchingEnquiries, 3);
  assert.equal(cleanup.preview('24h', 'alarms_only').matchingEnquiries, 4);
  assert.equal(cleanup.preview('all', 'alarms_only').matchingEnquiries, 5);
  assert.equal(cleanup.preview('all', 'enquiries_and_alarms').alarms, 10);
  assert.throws(() => cleanup.preview('2h', 'alarms_only'), /period/);
  assert.throws(() => cleanup.preview('1h', 'all_tables'), /target/);
  db.close();
});

test('administrator/developer endpoints execute; reception/read_only receive HTTP 403 and client actor IDs are ignored', () => {
  for (const role of ['developer', 'administrator', 'reception', 'read_only']) {
    const { db, writeAudit } = fixture({ rows: false });
    db.prepare('INSERT INTO enquiries VALUES (1,\'row\',\'new\',\'website\',\'2026-11-17T09:59:00.000Z\',\'2026-11-17T09:59:00.000Z\',NULL,NULL,NULL)').run();
    db.prepare('INSERT INTO enquiry_alarms VALUES (1,1,\'device-abcd-0001\',NULL,NULL,NULL,\'2026-11-17T09:59:00.000Z\')').run();
    const routes = new Map();
    const app = { get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) };
    const requireAuth = (req, res, next) => next();
    installEnquiryCleanup(app, db, requireAuth, writeAudit, { clock: () => FIXED_NOW, backup: testBackup });
    const invoke = (key, req) => {
      const response = { code: 200, payload: null, headers: {}, status(code) { this.code = code; return this; }, set(k, v) { this.headers[k] = v; return this; }, json(value) { this.payload = value; return this; } };
      let i = 0; const handlers = routes.get(key); const next = () => { const handler = handlers[i++]; if (handler) handler(req, response, next); };
      next(); return response;
    };
    const actorId = role === 'developer' ? 10 : 20;
    const staff = { id: actorId, username: role, role };
    const preview = invoke('GET /api/admin/enquiry-cleanup/preview', { session: { staff }, query: { period: '15m', target: 'enquiries_and_alarms' } });
    const execute = invoke('POST /api/admin/enquiry-cleanup/execute', { session: { staff }, body: { period: '15m', target: 'enquiries_and_alarms', confirmation: 'CLEAR', actor_staff_id: 999 } });
    if (role === 'developer' || role === 'administrator') {
      assert.equal(preview.code, 200, `${role} preview`);
      assert.equal(execute.code, 200, `${role} execute`);
      assert.equal(db.prepare('SELECT actor_staff_id FROM audit_log WHERE action=\'enquiry.cleanup.executed\'').get().actor_staff_id, actorId);
    } else {
      assert.equal(preview.code, 403, `${role} preview`);
      assert.equal(execute.code, 403, `${role} execute`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 1);
    }
    db.close();
  }
});

test('backup failure aborts before any deletion or audit insertion', () => {
  const { db, writeAudit } = fixture();
  const cleanup = createCleanupOperations(db, writeAudit, { clock: () => FIXED_NOW, backup: () => { throw new Error('backup unavailable'); } });
  assert.throws(() => cleanup.execute({ period: 'all', target: 'enquiries_and_alarms', confirmation: 'CLEAR', actor: { id: 1, username: 'admin' } }), /backup unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms').get().n, 10);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
  db.close();
});

test('enquiry cleanup cascades alarms, records exact counts and preserves unrelated hotel tables', () => {
  const { db, writeAudit } = fixture();
  const cleanup = createCleanupOperations(db, writeAudit, { clock: () => FIXED_NOW, backup: testBackup });
  const result = cleanup.execute({ period: '15m', target: 'enquiries_and_alarms', confirmation: 'CLEAR', actor: { id: 1, username: 'admin' } });
  assert.equal(result.deletedEnquiries, 2);
  assert.equal(result.deletedAlarms, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms').get().n, 6);
  assert.equal(db.prepare('SELECT reference FROM bookings').get().reference, 'KEEP-BOOKING');
  assert.equal(db.prepare('SELECT reference FROM payment_transactions').get().reference, 'KEEP-PAYMENT');
  const audit = db.prepare('SELECT actor_staff_id, details_json FROM audit_log').get();
  assert.equal(audit.actor_staff_id, 1);
  assert.equal(JSON.parse(audit.details_json).actor_username, 'admin');
  db.close();
});

test('alarms_only removes only selected alarms while retaining enquiries', () => {
  const { db, writeAudit } = fixture();
  const cleanup = createCleanupOperations(db, writeAudit, { clock: () => FIXED_NOW, backup: testBackup });
  const result = cleanup.execute({ period: '1h', target: 'alarms_only', confirmation: 'CLEAR', actor: { id: 1, username: 'admin' } });
  assert.equal(result.deletedEnquiries, 0);
  assert.equal(result.deletedAlarms, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms').get().n, 4);
  db.close();
});

test('transaction rollback preserves rows when audit insertion fails', () => {
  const { db } = fixture();
  const cleanup = createCleanupOperations(db, () => { throw new Error('audit unavailable'); }, { clock: () => FIXED_NOW, backup: testBackup });
  assert.throws(() => cleanup.execute({ period: '15m', target: 'enquiries_and_alarms', confirmation: 'CLEAR', actor: { id: 1, username: 'admin' } }), /audit unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms').get().n, 10);
  db.close();
});

test('execution aborts if selected data changes after backup and before the transaction', () => {
  const { db, writeAudit } = fixture();
  let count = 0;
  const cleanup = createCleanupOperations(db, writeAudit, { clock: () => FIXED_NOW, backup: () => { count++; db.prepare('INSERT INTO enquiries VALUES (99,\'new\',\'new\',\'website\',\'2026-11-17T09:59:30.000Z\',\'2026-11-17T09:59:30.000Z\',NULL,NULL,NULL)').run(); return testBackup(); } });
  assert.throws(() => cleanup.execute({ period: '15m', target: 'enquiries_and_alarms', confirmation: 'CLEAR', actor: { id: 1, username: 'admin' } }), error => error.code === 'CLEANUP_SELECTION_CHANGED');
  assert.equal(count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 6);
  db.close();
});


test('cleanup endpoints enforce authorization over real local HTTP requests', async t => {
  const { db, writeAudit } = fixture({ rows: false });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.get('x-test-role');
    if (role) req.session = { staff: { id: role === 'developer' ? 1 : 2, username: role, role } };
    next();
  });
  installEnquiryCleanup(app, db, (_req, _res, next) => next(), writeAudit, { clock: () => FIXED_NOW, backup: testBackup });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['developer', 'administrator']) {
    const response = await fetch(`${base}/api/admin/enquiry-cleanup/preview?period=all&target=alarms_only`, { headers: { 'x-test-role': role } });
    assert.equal(response.status, 200, `${role} should be authorized`);
  }
  for (const role of ['reception', 'read_only']) {
    const response = await fetch(`${base}/api/admin/enquiry-cleanup/preview?period=all&target=alarms_only`, { headers: { 'x-test-role': role } });
    assert.equal(response.status, 403, `${role} must be denied`);
  }
  const anonymous = await fetch(`${base}/api/admin/enquiry-cleanup/preview?period=all&target=alarms_only`);
  assert.equal(anonymous.status, 401);
});
