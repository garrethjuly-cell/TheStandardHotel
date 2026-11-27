'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../sqlite-adapter');
const { DeviceRegistrationError, updateEnquiryStatus, dismissDeviceAlarm, getDeviceAlarmState } = require('../enquiry-alarm-service');
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE enquiries (id INTEGER PRIMARY KEY, message TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'website', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, acknowledged_at TEXT, acknowledged_by_staff_id INTEGER, acknowledged_by_username TEXT);
    CREATE TABLE enquiry_devices (device_id TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE enquiry_alarms (id INTEGER PRIMARY KEY AUTOINCREMENT, enquiry_id INTEGER NOT NULL, device_id TEXT NOT NULL, dismissed_at TEXT, dismissed_by_staff_id INTEGER, dismissed_by_username TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(enquiry_id, device_id));
    INSERT INTO enquiries (id, message, status) VALUES (16, 'Test enquiry 16', 'new'), (17, 'Test enquiry 17', 'new');
    INSERT INTO enquiry_devices (device_id, staff_id, active) VALUES ('device-android-0001', 7, 1), ('device-other-0002', 8, 1);
    INSERT INTO enquiry_alarms (enquiry_id, device_id) VALUES (16, 'device-android-0001'), (16, 'device-other-0002'), (17, 'device-android-0001'), (17, 'device-other-0002');
  `);
  const audit = []; const writeAudit = (...args) => audit.push(args);
  return { db, audit, writeAudit };
}
test('acknowledgement dismisses this enquiry across all devices, not unrelated enquiries', () => {
  const { db, audit, writeAudit } = fixture();
  const result = updateEnquiryStatus(db, writeAudit, 7, 16, 'acknowledged', 'device-android-0001');
  assert.equal(result.enquiry.status, 'acknowledged');
  assert.deepEqual(result.affectedDeviceIds.sort(), ['device-android-0001', 'device-other-0002']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms WHERE enquiry_id=16 AND dismissed_at IS NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms WHERE enquiry_id=17 AND dismissed_at IS NULL').get().n, 2);
  assert.equal(audit.filter(entry => entry[1] === 'enquiry.alarm_dismissed').length, 2);
  db.close();
});
test('resolution is idempotent and prevents alarm state from remaining active', () => {
  const { db, writeAudit } = fixture();
  updateEnquiryStatus(db, writeAudit, 7, 16, 'resolved', 'device-android-0001');
  const second = updateEnquiryStatus(db, writeAudit, 7, 16, 'resolved', 'device-android-0001');
  assert.equal(second.enquiry.status, 'resolved');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms WHERE enquiry_id=16 AND dismissed_at IS NULL').get().n, 0);
  assert.deepEqual(getDeviceAlarmState(db, 'device-android-0001').activeAlarmEnquiryIds, [17]);
  db.close();
});
test('manual alarm dismissal is per-device, attributed, and idempotent', () => {
  const { db, writeAudit } = fixture();
  const first = dismissDeviceAlarm(db, writeAudit, 7, 16, 'device-android-0001', 'alice');
  const second = dismissDeviceAlarm(db, writeAudit, 7, 16, 'device-android-0001', 'alice');
  assert.deepEqual(first.affectedDeviceIds, ['device-android-0001']);
  assert.equal(first.alreadyDismissed, false);
  assert.equal(second.alreadyDismissed, true);
  assert.equal(db.prepare("SELECT dismissed_by_staff_id AS staff, dismissed_by_username AS username FROM enquiry_alarms WHERE enquiry_id=16 AND device_id='device-android-0001'").get().staff, 7);
  assert.equal(db.prepare("SELECT dismissed_by_username AS username FROM enquiry_alarms WHERE enquiry_id=16 AND device_id='device-android-0001'").get().username, 'alice');
  assert.equal(db.prepare("SELECT dismissed_at FROM enquiry_alarms WHERE enquiry_id=16 AND device_id='device-other-0002'").get().dismissed_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enquiry_alarms WHERE enquiry_id=16 AND dismissed_at IS NULL").get().n, 1);
  assert.deepEqual(getDeviceAlarmState(db, 'device-android-0001').activeAlarmEnquiryIds, [17]);
  db.close();
});

test('every explicit acknowledgement stores authenticated actor/time and preserves metadata after resolution', () => {
  const { db, audit, writeAudit } = fixture();
  const first = updateEnquiryStatus(db, writeAudit, 7, 16, 'acknowledged', 'device-android-0001', 'alice');
  const acknowledgedAt = first.enquiry.acknowledged_at;
  assert.equal(first.enquiry.acknowledged_by_staff_id, 7);
  assert.equal(first.enquiry.acknowledged_by_username, 'alice');
  assert.ok(acknowledgedAt);
  updateEnquiryStatus(db, writeAudit, 7, 16, 'acknowledged', 'device-android-0001', 'alice');
  updateEnquiryStatus(db, writeAudit, 7, 16, 'resolved', 'device-android-0001', 'alice');
  const stored = db.prepare('SELECT acknowledged_at, acknowledged_by_staff_id, acknowledged_by_username FROM enquiries WHERE id=16').get();
  assert.equal(stored.acknowledged_by_staff_id, 7);
  assert.equal(stored.acknowledged_by_username, 'alice');
  assert.ok(stored.acknowledged_at);
  assert.equal(audit.filter(entry => entry[1] === 'enquiry.acknowledged').length, 2);
  assert.ok(audit.filter(entry => entry[1] === 'enquiry.alarm_dismissed').every(entry => entry[4].device_id));
  db.close();
});
test('unregistered device cannot update status with a device dismissal request', () => {
  const { db, writeAudit } = fixture();
  assert.throws(() => updateEnquiryStatus(db, writeAudit, 7, 16, 'resolved', 'device-other-0002'), DeviceRegistrationError);
  assert.equal(db.prepare('SELECT status FROM enquiries WHERE id=16').get().status, 'new');
  db.close();
});
