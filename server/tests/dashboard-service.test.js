'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../sqlite-adapter');
const { getDashboardDeviceAlarmCount } = require('../dashboard-service');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE enquiries (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE enquiry_devices (device_id TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE enquiry_alarms (id INTEGER PRIMARY KEY, enquiry_id INTEGER NOT NULL, device_id TEXT NOT NULL, dismissed_at TEXT);
    INSERT INTO enquiries VALUES (1, 'new'), (2, 'acknowledged'), (3, 'resolved');
    INSERT INTO enquiry_devices VALUES ('device-master-0001', 10, 1), ('device-master-0002', 10, 1), ('device-testacc-01', 20, 1);
    INSERT INTO enquiry_alarms (id, enquiry_id, device_id, dismissed_at) VALUES (1, 1, 'device-master-0001', NULL);
  `);
  return db;
}

test('dashboard safely infers the only registered device for older app clients', () => {
  const db = fixture();
  const result = getDashboardDeviceAlarmCount(db, 20, '');
  assert.equal(result.activeAlarmsForThisDevice, 0);
  assert.equal(result.dashboardDeviceId, 'device-testacc-01');
  assert.equal(result.activeAlarmScope, 'inferred_single_registered_device');
  db.close();
});

test('dashboard requires explicit device ID when staff has multiple devices', () => {
  const db = fixture();
  const result = getDashboardDeviceAlarmCount(db, 10, '');
  assert.equal(result.activeAlarmScope, 'device_id_required_multiple_devices');
  assert.equal(result.activeAlarmsForThisDevice, 0);
  db.close();
});

test('dashboard rejects device IDs belonging to another staff account', () => {
  const db = fixture();
  assert.equal(getDashboardDeviceAlarmCount(db, 20, 'device-master-0001').error, 'DEVICE_NOT_REGISTERED');
  db.close();
});

test('dashboard counts only active alarms for the selected device', () => {
  const db = fixture();
  const result = getDashboardDeviceAlarmCount(db, 10, 'device-master-0001');
  assert.equal(result.activeAlarmsForThisDevice, 1);
  assert.equal(result.dashboardDeviceId, 'device-master-0001');
  db.close();
});
