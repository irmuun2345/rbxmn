// Proof that money arrived: gateway confirmations, and the bank-transfer
// receipts buyers upload by hand.
//
// Both tables carry a UNIQUE constraint that is the actual anti-double-spend
// mechanism. Neither is a convenience index — deleting one would let a single
// payment fund two deliveries.

const { run } = require('./helpers');

module.exports = function applyPaymentSchema(db) {
  // Every confirmation a payment provider has ever sent us, applied or not.
  //
  // A gateway will re-send a callback on timeout, on retry, and sometimes for
  // no reason at all — and a replayed confirmation that approved an order
  // twice would deliver Robux twice.
  //
  // Rejected confirmations are recorded too. A payment that arrived for an
  // unknown reference, or for the wrong amount, is exactly what someone needs
  // to see when a customer says they paid and nothing happened.
  run(db, 'payments table', `CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_payment_id TEXT NOT NULL,
    payment_reference TEXT,
    amount_mnt INTEGER,
    entity_type TEXT,
    entity_id INTEGER,
    outcome TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);

  // One row per provider transaction, forever. This is the single line that
  // stops a replayed webhook becoming a second delivery: the duplicate INSERT
  // fails and the caller stops.
  run(db, 'payment idempotency index',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_txn
     ON payments (provider, provider_payment_id)`);

  // The file itself lives on disk under uploads/receipts (never inside
  // public/), and this row is the only way to reach it — serving goes through
  // an admin-authenticated route.
  //
  // sha256 is UNIQUE across the whole table, and that single constraint is
  // what enforces "a payment must not be used for multiple successful
  // top-ups": re-uploading the same image against a second order fails at the
  // INSERT rather than reaching an admin who might approve it twice.
  run(db, 'receipts table', `CREATE TABLE IF NOT EXISTS receipts (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    uploaded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  run(db, 'receipts entity index',
    'CREATE INDEX IF NOT EXISTS idx_receipts_entity ON receipts (entity_type, entity_id)');
};
