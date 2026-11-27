'use strict';

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function applyEnquiryAccountabilityMigration(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  if (!tables.has('enquiries') || !tables.has('enquiry_alarms')) {
    throw new Error('Enquiry tables must exist before applying the accountability migration.');
  }
  const tx = db.transaction(() => {
    ensureColumn(db, 'enquiries', 'sender_name', 'TEXT');
    ensureColumn(db, 'enquiries', 'sender_phone', 'TEXT');
    ensureColumn(db, 'enquiries', 'sender_jid', 'TEXT');
    ensureColumn(db, 'enquiries', 'acknowledged_at', 'TEXT');
    ensureColumn(db, 'enquiries', 'acknowledged_by_staff_id', 'INTEGER REFERENCES staff(id) ON DELETE SET NULL');
    ensureColumn(db, 'enquiries', 'acknowledged_by_username', 'TEXT');
    ensureColumn(db, 'enquiry_alarms', 'dismissed_by_username', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_enquiry_alarms_enquiry_dismissed
        ON enquiry_alarms(enquiry_id, dismissed_at);
      CREATE INDEX IF NOT EXISTS idx_enquiry_alarms_device_dismissed
        ON enquiry_alarms(device_id, dismissed_at);
    `);
  });
  tx.immediate();
}

module.exports = { applyEnquiryAccountabilityMigration };
