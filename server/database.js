const Database = require('./sqlite-adapter');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'hotel.db'));

const roomsTableBeforeInit = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rooms'").get();
const roomsColumnsBeforeInit = roomsTableBeforeInit ? db.prepare('PRAGMA table_info(rooms)').all().map(column => column.name) : [];
const needsInventoryMigration = Boolean(roomsTableBeforeInit && !roomsColumnsBeforeInit.includes('inventory_count'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (
      role IN (
        'developer',
        'administrator',
        'reception',
        'read_only'
      )
    ),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_single REAL,
    price_double REAL,
    price REAL,
    inventory_count INTEGER NOT NULL DEFAULT 0 CHECK (inventory_count >= 0 AND inventory_count <= 10000),
    content_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS addons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL CHECK (price >= 0),
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    checkin TEXT NOT NULL,
    checkout TEXT NOT NULL,
    guests INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    room_name TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    booking_status TEXT NOT NULL DEFAULT 'pending',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    selected_addons_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS booking_holds (
    reference TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    checkin TEXT NOT NULL,
    checkout TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_booking_holds_dates ON booking_holds (room_id, checkin, checkout, status);

  CREATE TABLE IF NOT EXISTS payment_transactions (
    reference TEXT PRIMARY KEY,
    booking_json TEXT NOT NULL,
    poll_url TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
    paynow_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_payment_transactions_status ON payment_transactions(status);

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    explanation TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    media_url TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL DEFAULT 'none',
    published INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS web_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_web_sessions_expire ON web_sessions(expire);

  CREATE TABLE IF NOT EXISTS whatsapp_gateway_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    notification_key TEXT NOT NULL,
    gateway_device_id TEXT NOT NULL,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
    package_name TEXT NOT NULL,
    sender TEXT,
    message_preview TEXT,
    posted_at_epoch_ms INTEGER NOT NULL,
    preview_available INTEGER NOT NULL DEFAULT 0 CHECK (preview_available IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_events_enquiry ON whatsapp_gateway_events(enquiry_id, posted_at_epoch_ms);

  CREATE TABLE IF NOT EXISTS whatsapp_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','opened','marked_sent')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_handoffs_enquiry ON whatsapp_handoffs(enquiry_id, created_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_staff_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_staff_id) REFERENCES staff(id)
      ON DELETE SET NULL
  );
`);

// Backward-compatible inventory migration for existing staging databases.
const roomColumnsAfterInit = db.prepare('PRAGMA table_info(rooms)').all().map(column => column.name);
if (!roomColumnsAfterInit.includes('inventory_count')) {
  db.exec('ALTER TABLE rooms ADD COLUMN inventory_count INTEGER NOT NULL DEFAULT 0 CHECK (inventory_count >= 0 AND inventory_count <= 10000)');
}
if (needsInventoryMigration) {
  // Initial values are applied once, only when introducing the new field.
  db.prepare("UPDATE rooms SET inventory_count = CASE id WHEN 'standard' THEN 4 WHEN 'executive' THEN 4 WHEN 'deluxe' THEN 2 WHEN 'penthouse' THEN 1 ELSE 0 END").run();
}

// Seed default inventory only when a room/add-on ID is missing. Existing prices
// and hotel records are never overwritten by startup.
const seedRoom = db.prepare(`INSERT OR IGNORE INTO rooms
  (id, name, price_single, price_double, price, inventory_count, content_json)
  VALUES (?, ?, ?, ?, ?, ?, '{}')`);
[
  ['standard', 'Standard Suite', 50, 60, 50, 4],
  ['executive', 'Executive Suite', 60, 70, 60, 4],
  ['deluxe', 'Deluxe Suite', 100, 100, 100, 2],
  ['penthouse', 'Penthouse Suite', 150, 150, 150, 1]
].forEach(room => seedRoom.run(...room));

const seedAddon = db.prepare(`INSERT OR IGNORE INTO addons (id, name, price, active)
  VALUES (?, ?, ?, 1)`);
[
  ['breakfast', 'Breakfast for two', 32],
  ['transfer', 'Airport transfer', 45],
  ['spa', 'Spa credit', 75],
  ['late', 'Late check-out', 30],
  ['celebration', 'Celebration setup', 55]
].forEach(addon => seedAddon.run(...addon));

module.exports = db;
