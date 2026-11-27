'use strict';

const db = require('./database');
const { applyEnquiryAccountabilityMigration } = require('./enquiry-accountability-migration');

const statements = [
  `CREATE TABLE IF NOT EXISTS enquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'acknowledged', 'resolved')),
    source TEXT NOT NULL DEFAULT 'website',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS enquiry_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL UNIQUE,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    fcm_token TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS enquiry_alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    dismissed_at TEXT,
    dismissed_by_staff_id INTEGER REFERENCES staff(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (enquiry_id, device_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_enquiries_created
    ON enquiries(created_at)`,

  `CREATE INDEX IF NOT EXISTS idx_enquiries_status
    ON enquiries(status)`,

  `CREATE INDEX IF NOT EXISTS idx_enquiry_alarms_active
    ON enquiry_alarms(device_id, dismissed_at)`,

  `CREATE INDEX IF NOT EXISTS idx_enquiry_devices_staff
    ON enquiry_devices(staff_id, active)`
];

try {
  for (const sql of statements) {
    db.prepare(sql).run();
  }
  applyEnquiryAccountabilityMigration(db);

  // Backward-compatible gateway heartbeat field for existing staging databases.
  const deviceColumns = db.prepare('PRAGMA table_info(enquiry_devices)').all().map(column => column.name);
  if (!deviceColumns.includes('last_seen_at')) {
    db.exec('ALTER TABLE enquiry_devices ADD COLUMN last_seen_at TEXT');
  }

  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('enquiries', 'enquiry_devices', 'enquiry_alarms')
    ORDER BY name
  `).all();

  console.log('Enquiry database migration completed.');
  console.log('Tables available:', tables.map(t => t.name).join(', '));
} catch (error) {
  console.error('Enquiry migration failed:', error.message);
  process.exitCode = 1;
}
