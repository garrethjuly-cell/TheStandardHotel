'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../sqlite-adapter');
const { validateDeviceRegistration, touchGatewayDevice, seedPendingEnquiryAlarmsForDevice } = require('../device-security');
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE enquiry_devices (device_id TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, fcm_token TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT);
    INSERT INTO enquiry_devices(device_id,staff_id,fcm_token,active) VALUES ('device-master-0001',1,'fcm-token-master-0000000000000001',1),('device-testacc-0001',2,'fcm-token-testacc-0000000000000002',1);`);
  return db;
}
test('registration cannot transfer an existing device ID to another staff account', () => {
  const db = fixture();
  const result = validateDeviceRegistration(db, 2, 'device-master-0001', 'fcm-token-new-0000000000000003');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEVICE_OWNERSHIP_CONFLICT');
  db.close();
});
test('registration cannot reuse another active device FCM token', () => {
  const db = fixture();
  const result = validateDeviceRegistration(db, 2, 'device-testacc-0001', 'fcm-token-master-0000000000000001');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FCM_TOKEN_ALREADY_REGISTERED');
  db.close();
});
test('gateway heartbeat only touches the authenticated owner device', () => {
  const db = fixture();
  assert.equal(touchGatewayDevice(db, 2, 'device-master-0001'), null);
  assert.ok(touchGatewayDevice(db, 1, 'device-master-0001').last_seen_at);
  db.close();
});
test('inactive devices cannot send gateway heartbeats', () => {
  const db = fixture();
  db.prepare("UPDATE enquiry_devices SET active=0 WHERE device_id='device-master-0001'").run();
  assert.equal(touchGatewayDevice(db, 1, 'device-master-0001'), null);
  db.close();
});


test('newly registered devices receive alarms only for new enquiries, never acknowledged or resolved ones', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE enquiries (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE enquiry_alarms (id INTEGER PRIMARY KEY, enquiry_id INTEGER NOT NULL, device_id TEXT NOT NULL, UNIQUE(enquiry_id, device_id));
    INSERT INTO enquiries (id, status) VALUES (1, 'new'), (2, 'acknowledged'), (3, 'resolved');
  `);
  const created = seedPendingEnquiryAlarmsForDevice(db, 'device-12345678');
  assert.equal(created, 1);
  const rows = db.prepare('SELECT enquiry_id FROM enquiry_alarms WHERE device_id=? ORDER BY enquiry_id').all('device-12345678');
  assert.deepEqual(rows.map(row => row.enquiry_id), [1]);
  assert.equal(seedPendingEnquiryAlarmsForDevice(db, 'device-12345678'), 0, 're-running registration must be idempotent');
  db.close();
});
