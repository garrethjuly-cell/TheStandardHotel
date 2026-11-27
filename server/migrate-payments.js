const db = require('./database');

db.exec(`
  CREATE TABLE IF NOT EXISTS payment_transactions (
    reference TEXT PRIMARY KEY,
    booking_json TEXT NOT NULL,
    poll_url TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
    paynow_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_payment_transactions_status
  ON payment_transactions(status);
`);

console.log('Payment transaction table is ready.');
db.close();
