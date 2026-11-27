'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../sqlite-adapter');
const { installResetManager } = require('../reset-manager');

test('reset manager enforces permissions, selectively deletes, backs up and preserves protected records', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standard-reset-test-'));
  const backupDir = path.join(tempDir, 'backups');
  const db = new Database(path.join(tempDir, 'test.sqlite'));
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE staff (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE booking_holds (reference TEXT PRIMARY KEY);
    CREATE TABLE enquiries (id INTEGER PRIMARY KEY, message TEXT, source TEXT DEFAULT 'website');
    CREATE TABLE enquiry_alarms (id INTEGER PRIMARY KEY, enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE CASCADE);
    CREATE TABLE enquiry_devices (id INTEGER PRIMARY KEY, device_id TEXT);
    CREATE TABLE reviews (id INTEGER PRIMARY KEY, guest_name TEXT);
    CREATE TABLE content_items (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor_staff_id INTEGER, action TEXT, target_type TEXT, target_id TEXT, details_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(actor_staff_id) REFERENCES staff(id) ON DELETE SET NULL);
    CREATE TABLE web_sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, reference TEXT);
    CREATE TABLE payment_transactions (reference TEXT PRIMARY KEY, amount REAL);
    INSERT INTO staff VALUES (1, 'developer');
    INSERT INTO reviews VALUES (1, 'Test review');
    INSERT INTO content_items VALUES (1, 'Test content');
    INSERT INTO enquiries VALUES (1, 'Guest enquiry', 'website');
    INSERT INTO enquiries VALUES (2, '[SYSTEM TEST] Test notification', 'system_test');
    INSERT INTO enquiry_alarms VALUES (1, 1);
    INSERT INTO enquiry_devices VALUES (1, 'android-device');
    INSERT INTO bookings VALUES (1, 'BOOKING-1');
    INSERT INTO payment_transactions VALUES ('PAY-1', 99);
    INSERT INTO audit_log (actor_staff_id, action, target_type, target_id, details_json) VALUES (1, 'before.reset', 'test', '1', '{}');`);
  const routes = {};
  const app = {
    get: (route, ...handlers) => { routes[`GET ${route}`] = handlers.at(-1); },
    post: (route, ...handlers) => { routes[`POST ${route}`] = handlers.at(-1); },
    put: (route, ...handlers) => { routes[`PUT ${route}`] = handlers.at(-1); }
  };
  const auth = (_req, _res, next) => next();
  const writeAudit = (actor, action, targetType, targetId, details) => db.prepare(
    'INSERT INTO audit_log (actor_staff_id, action, target_type, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
  ).run(actor, action, targetType, String(targetId), JSON.stringify(details));
  installResetManager(app, db, auth, writeAudit, { backupDir });

  function call(method, route, body = {}, role = 'developer') {
    let status = 200; let payload;
    const req = { body, session: { staff: { id: 1, username: 'developer', role }, destroy(callback) { callback(null); } } };
    const res = { set() { return this; }, status(code) { status = code; return this; }, json(value) { payload = value; return this; }, clearCookie() {} };
    routes[`${method} ${route}`](req, res, () => {});
    return { status, payload };
  }

  try {
    const options = call('GET', '/api/admin/reset-options');
    assert.equal(options.payload.categories.length, 9);
    assert.ok(options.payload.categories.some(c => c.key === 'enquiries'));
    assert.equal(call('POST', '/api/admin/reset-preview', { categories: ['reviews'] }, 'reception').status, 403);

    const permissionUpdate = call('PUT', '/api/admin/reset-permissions', {
      permissions: { administrator: ['reviews'], reception: ['enquiry_alarms'], read_only: [] }
    });
    assert.equal(permissionUpdate.payload.success, true);
    assert.equal(call('POST', '/api/admin/reset-preview', { categories: ['enquiries'] }, 'administrator').status, 403);
    assert.equal(call('POST', '/api/admin/reset-preview', { categories: ['enquiry_alarms'] }, 'reception').payload.success, true);

    const preview = call('POST', '/api/admin/reset-preview', { categories: ['reviews', 'audit_log'] });
    assert.equal(preview.payload.totalRecords, 3);
    const executed = call('POST', '/api/admin/reset-execute', { previewId: preview.payload.previewId, confirmation: 'RESET' });
    assert.equal(executed.payload.success, true);
    assert.equal(executed.payload.totalDeleted, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_items').get().n, 1, 'unselected category remains untouched');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1, 'new audit entry remains after clearing history');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reset_operations').get().n, 1, 'separate reset history remains');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1, 'confirmed booking table is protected');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_transactions').get().n, 1, 'payment transaction table is protected');
    assert.equal(fs.readdirSync(backupDir).length, 1, 'pre-reset backup is created in isolated backup directory');

    const markedPreview = call('POST', '/api/admin/reset-preview', { categories: ['test_enquiries'] });
    assert.equal(markedPreview.payload.totalRecords, 1, 'only the explicitly marked system-test enquiry is counted');
    const markedReset = call('POST', '/api/admin/reset-execute', { previewId: markedPreview.payload.previewId, confirmation: 'RESET' });
    assert.equal(markedReset.payload.success, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 1, 'unmarked guest enquiry remains after test-only cleanup');

    const enquiryPreview = call('POST', '/api/admin/reset-preview', { categories: ['enquiries'] });
    const enquiryReset = call('POST', '/api/admin/reset-execute', { previewId: enquiryPreview.payload.previewId, confirmation: 'RESET' });
    assert.equal(enquiryReset.payload.success, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiry_alarms').get().n, 0, 'linked alarms cascade with deleted enquiries');

    assert.equal(call('POST', '/api/admin/reset-preview', { categories: ['bookings'] }).status, 400, 'unlisted/protected tables cannot be targeted');
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
