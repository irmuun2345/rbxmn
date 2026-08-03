// Gift cards: paid for up front, approved by an admin, then redeemed once by
// whoever the buyer shares the code with — straight into the redeemer's own
// linked Roblox account.

const { run, addMissingColumns } = require('./helpers');

module.exports = function applyGiftCardSchema(db) {
  run(db, 'gift_cards table', `CREATE TABLE IF NOT EXISTS gift_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    robux_amount INTEGER NOT NULL,
    price_mnt INTEGER NOT NULL,
    payment_reference TEXT,
    purchaser_user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_payment',
    redeemed_by_user_id INTEGER,
    redeemed_order_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    approved_at DATETIME,
    redeemed_at DATETIME,
    FOREIGN KEY (purchaser_user_id) REFERENCES users (id),
    FOREIGN KEY (redeemed_by_user_id) REFERENCES users (id)
  )`);

  // The same guarantee game_passes already had, and for the same reason: a
  // payment reference is the only thing tying a bank transfer to what it
  // bought, so two rows must never advertise the same one. Without this,
  // generateUniqueReference's collision loop was the *only* protection for
  // gift cards — and a loop that checks then inserts is exactly what a unique
  // index exists to backstop.
  //
  // Partial, because a reference is nullable and SQLite would otherwise treat
  // every NULL as distinct anyway; being explicit documents the intent.
  //
  // A pre-existing duplicate makes this fail. Loud rather than fatal: the
  // rest of the app works, and the fix is a manual reconciliation of the two
  // rows involved.
  run(db, 'gift card payment reference index',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_payment_reference
     ON gift_cards (payment_reference) WHERE payment_reference IS NOT NULL`);

  // Gift cards gained a rejection reason at the same time orders did.
  addMissingColumns(db, 'gift_cards', [['rejection_reason', 'TEXT']]);
};
