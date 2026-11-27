'use strict';

const crypto = require('crypto');
const { applyEnquiryAccountabilityMigration } = require('./enquiry-accountability-migration');

function safeBearerMatch(header, expected) {
  if (typeof header !== 'string' || typeof expected !== 'string' || !expected) return false;
  const supplied = Buffer.from(header.replace(/^Bearer\s+/i, '').trim());
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted);
}

function extractMessage(data) {
  const key = data && data.key;
  if (!key || key.fromMe === true) return null;
  const remoteJid = String(key.remoteJid || '');
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return null;
  const message = data.message || {};
  const text = message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.documentMessage?.caption
    || message.buttonsResponseMessage?.selectedDisplayText
    || message.listResponseMessage?.title
    || message.templateButtonReplyMessage?.selectedDisplayText;
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return null;
  const phoneCandidates = [key.senderPn, data.senderPn, key.remoteJidAlt, data.remoteJidAlt, remoteJid];
  let senderPhone = null;
  for (const candidate of phoneCandidates) {
    if (typeof candidate !== 'string' || !candidate.trim() || /@(lid|g\.us|broadcast)$/i.test(candidate.trim())) continue;
    const userPart = candidate.trim().split('@')[0].split(':')[0];
    const digits = userPart.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) { senderPhone = digits; break; }
  }
  return {
    eventId: String(key.id || ''),
    remoteJid,
    sender: remoteJid.replace(/@s\.whatsapp\.net$/, ''),
    senderPhone,
    senderName: String(data.pushName || data.pushname || data.notifyName || data.senderName || '').trim().slice(0, 160) || null,
    senderJid: remoteJid.slice(0, 200),
    message: body.slice(0, 2000),
    timestamp: data.messageTimestamp || data.messageTimestamp?.low || null
  };
}

function installWhatsAppWebhook(app, db, sendEnquiryNotifications, writeAudit) {
  // Idempotent schema setup: preserves all existing hotel, staff and enquiry rows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','acknowledged','resolved')),
      source TEXT NOT NULL DEFAULT 'website',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS enquiry_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      staff_id INTEGER NOT NULL REFERENCES staff(id),
      fcm_token TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS enquiry_alarms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      dismissed_at TEXT,
      dismissed_by_staff_id INTEGER REFERENCES staff(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(enquiry_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
      event_id TEXT PRIMARY KEY,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_enquiries_created ON enquiries(created_at);
    CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries(status);
    CREATE INDEX IF NOT EXISTS idx_enquiry_alarms_active ON enquiry_alarms(device_id, dismissed_at);
    CREATE INDEX IF NOT EXISTS idx_enquiry_devices_staff ON enquiry_devices(staff_id, active);
  `);
  applyEnquiryAccountabilityMigration(db);

  app.post('/webhook/whatsapp', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const secret = process.env.EVOLUTION_WEBHOOK_TOKEN;
    if (!safeBearerMatch(req.get('authorization'), secret)) {
      return res.status(401).json({ success: false, error: 'Unauthorized webhook.' });
    }

    const eventName = String(req.body?.event || '').toLowerCase();
    if (eventName !== 'messages.upsert' && eventName !== 'messages_upsert') {
      return res.status(200).json({ success: true, ignored: true, reason: 'Event not used.' });
    }

    const instance = String(req.body?.instance || process.env.EVOLUTION_INSTANCE || '');
    if (process.env.EVOLUTION_INSTANCE && instance !== process.env.EVOLUTION_INSTANCE) {
      return res.status(202).json({ success: true, ignored: true, reason: 'Unexpected instance.' });
    }
    const records = Array.isArray(req.body?.data) ? req.body.data : [req.body?.data];
    const outcomes = [];

    for (const record of records) {
      const parsed = extractMessage(record);
      if (!parsed || !parsed.eventId) {
        outcomes.push({ accepted: false, reason: 'No supported inbound text message.' });
        continue;
      }
      const eventId = `${instance}:${parsed.eventId}`.slice(0, 300);
      try {
        const result = db.transaction(() => {
          const existing = db.prepare('SELECT enquiry_id FROM whatsapp_webhook_events WHERE event_id = ?').get(eventId);
          if (existing) return { duplicate: true, id: Number(existing.enquiry_id), deviceCount: 0 };
          const created = db.prepare(`INSERT INTO enquiries(message,status,source,sender_name,sender_phone,sender_jid) VALUES(?,'new','whatsapp_business',?,?,?)`).run(parsed.message, parsed.senderName || null, parsed.senderPhone || null, parsed.senderJid || null);
          const enquiryId = Number(created.lastInsertRowid);
          const devices = db.prepare('SELECT device_id FROM enquiry_devices WHERE active = 1').all();
          const addAlarm = db.prepare('INSERT OR IGNORE INTO enquiry_alarms(enquiry_id,device_id) VALUES(?,?)');
          for (const device of devices) addAlarm.run(enquiryId, device.device_id);
          db.prepare('INSERT INTO whatsapp_webhook_events(event_id,enquiry_id) VALUES(?,?)').run(eventId, enquiryId);
          if (typeof writeAudit === 'function') writeAudit(null, 'enquiry.created', 'enquiry', enquiryId, { source: 'whatsapp_business' });
          return { duplicate: false, id: enquiryId, deviceCount: devices.length };
        }).immediate();

        if (!result.duplicate) {
          try {
            const tokens = db.prepare('SELECT fcm_token FROM enquiry_devices WHERE active = 1').all().map(row => row.fcm_token);
            const delivery = await sendEnquiryNotifications(tokens, { id: result.id, message: parsed.message, status: 'new', senderName: parsed.senderName, senderPhone: parsed.senderPhone });
            for (const token of delivery.invalidTokens || []) {
              db.prepare('UPDATE enquiry_devices SET active=0, updated_at=CURRENT_TIMESTAMP WHERE fcm_token=?').run(token);
            }
          } catch (error) {
            console.error('[WhatsApp webhook] FCM delivery failed for enquiry', result.id, error.code || error.message);
          }
        }
        outcomes.push({ accepted: true, duplicate: result.duplicate, enquiryId: result.id });
      } catch (error) {
        console.error('[WhatsApp webhook] Message processing failed:', error.message);
        outcomes.push({ accepted: false, reason: 'Message could not be saved.' });
      }
    }

    return res.status(200).json({ success: true, processed: outcomes.length, outcomes });
  });
}

module.exports = { installWhatsAppWebhook };
