// Orders and the ledger of Roblox transactions behind them.
//
// The table is still called `game_passes` for historical reasons: it began as
// a record of Game Passes and grew into the order table when group payouts
// were added. Renaming it would mean rewriting every repository query for no
// behavioural gain, so the name stays and this comment explains it.

const { ORDER_STATUS } = require('../../services/order-status');
const { run, addMissingColumns } = require('./helpers');

// Columns added after the table first shipped, oldest first.
const ADDED_COLUMNS = [
  ['universe_id', 'INTEGER'],
  ['listed_price', 'INTEGER'],
  ['amount_mnt', 'INTEGER'],
  ['rate_per_100_mnt', 'INTEGER'],
  ['status', "TEXT NOT NULL DEFAULT 'legacy'"],
  ['payment_reference', 'TEXT'],
  ['delivery_method', "TEXT NOT NULL DEFAULT 'gamepass'"],
  ['delivered_robux', 'INTEGER'],
  ['bonus_percent', 'REAL NOT NULL DEFAULT 0'],
  // Set the moment we start talking to Roblox about a delivery, so an order
  // stuck in FULFILLMENT_PROCESSING can be aged and surfaced.
  ['fulfillment_started_at', 'DATETIME'],
  ['fulfillment_error', 'TEXT'],
  ['rejection_reason', 'TEXT'],
  ['reviewed_by_admin_id', 'INTEGER'],
  ['reviewed_at', 'DATETIME'],
  ['completed_at', 'DATETIME'],
  // Recorded per order so a later change to the global referral rate never
  // rewrites what an existing order was promised.
  ['referral_bonus_percent', 'REAL NOT NULL DEFAULT 0'],
  ['referral_code_id', 'INTEGER']
];

// Status vocabulary migration, oldest name first. Each historic status maps
// onto exactly one state in the current nine-state flow; running these
// repeatedly is harmless because the source names no longer exist after the
// first pass.
const RENAMED_STATUSES = [
  ['awaiting_purchase', ORDER_STATUS.FULFILLMENT_PENDING],
  ['ready_to_purchase', ORDER_STATUS.FULFILLMENT_PENDING],
  ['purchased', ORDER_STATUS.COMPLETED]
];

module.exports = function applyOrderSchema(db) {
  run(db, 'game_passes table', `CREATE TABLE IF NOT EXISTS game_passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL,
    roblox_gamepass_id INTEGER,
    universe_id INTEGER,
    listed_price INTEGER,
    amount_mnt INTEGER,
    rate_per_100_mnt INTEGER,
    status TEXT NOT NULL DEFAULT 'legacy',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  addMissingColumns(db, 'game_passes', ADDED_COLUMNS, () => {
    RENAMED_STATUSES.forEach(([from, to]) => {
      run(db, `order status ${from} -> ${to}`,
        'UPDATE game_passes SET status = ? WHERE status = ?', [to, from]);
    });

    // Backfill completed_at for orders that finished before the column
    // existed, so the history view isn't full of blanks.
    run(db, 'completed_at backfill',
      `UPDATE game_passes SET completed_at = created_at
       WHERE status = ? AND completed_at IS NULL`, [ORDER_STATUS.COMPLETED]);

    // A reference code identifies exactly one payment. Enforcing that at the
    // DB layer (rather than trusting the random generator) is what makes the
    // "one payment, one top-up" rule real — see generateUniqueReference in
    // src/services/payment-reference.js for the retry-on-collision path.
    //
    // Created in here rather than alongside the CREATE TABLE above because
    // payment_reference is one of the added columns: issued outside this
    // callback it runs before the ALTER and fails with "no such column",
    // leaving a fresh install with no uniqueness guarantee at all.
    run(db, 'payment reference unique index',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_passes_payment_reference
       ON game_passes (payment_reference) WHERE payment_reference IS NOT NULL`);
  });

  run(db, 'transactions table', `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gamepass_id INTEGER NOT NULL,
    buyer_id INTEGER NOT NULL,
    seller_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    roblox_transaction_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (gamepass_id) REFERENCES game_passes (id),
    FOREIGN KEY (buyer_id) REFERENCES users (id),
    FOREIGN KEY (seller_id) REFERENCES users (id)
  )`);
};
