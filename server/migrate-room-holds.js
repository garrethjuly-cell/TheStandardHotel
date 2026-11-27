const db = require('./database');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_holds (
      reference TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      checkin TEXT NOT NULL,
      checkout TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'confirmed', 'released')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_booking_holds_dates
      ON booking_holds (room_id, checkin, checkout, status);
  `);

  console.log('Room-holds table is ready.');
  console.log(
    db.prepare("PRAGMA table_info(booking_holds)").all()
  );
} finally {
  db.close();
}
