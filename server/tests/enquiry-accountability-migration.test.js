'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../sqlite-adapter');
const { applyEnquiryAccountabilityMigration } = require('../enquiry-accountability-migration');

test('accountability migration adds nullable attribution columns idempotently and preserves existing rows', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE staff (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO staff VALUES (1, 'legacy');
    CREATE TABLE enquiries (id INTEGER PRIMARY KEY, message TEXT, status TEXT, source TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE enquiry_alarms (id INTEGER PRIMARY KEY, enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE CASCADE, device_id TEXT, dismissed_at TEXT, dismissed_by_staff_id INTEGER REFERENCES staff(id), created_at TEXT);
    INSERT INTO enquiries VALUES (1, 'keep', 'acknowledged', 'website', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    INSERT INTO enquiry_alarms VALUES (1, 1, 'device-00000001', '2026-01-01 00:01:00', 1, '2026-01-01 00:00:00');
  `);
  applyEnquiryAccountabilityMigration(db);
  applyEnquiryAccountabilityMigration(db);
  const enquiry = db.prepare('SELECT * FROM enquiries WHERE id=1').get();
  const alarm = db.prepare('SELECT * FROM enquiry_alarms WHERE id=1').get();
  assert.equal(enquiry.message, 'keep');
  assert.equal(enquiry.status, 'acknowledged');
  assert.equal(enquiry.acknowledged_at, null);
  assert.equal(enquiry.acknowledged_by_staff_id, null);
  assert.equal(alarm.dismissed_at, '2026-01-01 00:01:00');
  assert.equal(alarm.dismissed_by_staff_id, 1);
  assert.equal(alarm.dismissed_by_username, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_enquiry_alarms_enquiry_dismissed'").get().n, 1);
  db.close();
});
