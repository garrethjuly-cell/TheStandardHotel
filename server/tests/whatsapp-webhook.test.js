'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../sqlite-adapter');
const { installWhatsAppWebhook } = require('../whatsapp-webhook');

test('Evolution WhatsApp webhook authenticates, creates one enquiry/alarm, and deduplicates retries', async () => {
  const oldToken = process.env.EVOLUTION_WEBHOOK_TOKEN;
  const oldInstance = process.env.EVOLUTION_INSTANCE;
  process.env.EVOLUTION_WEBHOOK_TOKEN = 'test-only-evolution-token';
  process.env.EVOLUTION_INSTANCE = 'test-instance';
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE staff(id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO staff VALUES(1,'staff-a'),(2,'staff-b');`);
  let route;
  const app = { post: (path, handler) => { if (path === '/webhook/whatsapp') route = handler; } };
  const deliveries = [];
  installWhatsAppWebhook(app, db, async (tokens, enquiry) => { deliveries.push({ tokens, enquiry }); return { invalidTokens: [] }; }, () => {});
  db.prepare('INSERT INTO enquiry_devices(device_id,staff_id,fcm_token,active) VALUES(?,?,?,1)').run('device-android-0001', 1, 'token-a');
  db.prepare('INSERT INTO enquiry_devices(device_id,staff_id,fcm_token,active) VALUES(?,?,?,1)').run('device-android-0002', 2, 'token-b');
  const request = {
    get: name => name.toLowerCase() === 'authorization' ? 'Bearer test-only-evolution-token' : undefined,
    body: { event: 'messages.upsert', instance: 'test-instance', data: { key: { id: 'event-1', fromMe: false, remoteJid: '263771234567@s.whatsapp.net' }, message: { conversation: 'Please reserve a room.' } } }
  };
  const invoke = async (req) => {
    const response = { code: 200, payload: null, status(code) { this.code = code; return this; }, set() { return this; }, json(value) { this.payload = value; return this; } };
    await route(req, response);
    return response;
  };
  try {
    const first = await invoke(request);
    assert.equal(first.code, 200);
    assert.equal(first.payload.outcomes[0].accepted, true);
    assert.equal(first.payload.outcomes[0].duplicate, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE source='whatsapp_business'").get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms').get().n, 2);
    const second = await invoke(request);
    assert.equal(second.payload.outcomes[0].duplicate, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms').get().n, 2);
    assert.equal(deliveries.length, 1);
  } finally {
    db.close();
    if (oldToken === undefined) delete process.env.EVOLUTION_WEBHOOK_TOKEN; else process.env.EVOLUTION_WEBHOOK_TOKEN = oldToken;
    if (oldInstance === undefined) delete process.env.EVOLUTION_INSTANCE; else process.env.EVOLUTION_INSTANCE = oldInstance;
  }
});
