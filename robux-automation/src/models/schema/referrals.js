// The referral programme: who owns which code, who they brought in, what
// that earned, and what has been paid out against it.

const { run, seedSettings } = require('./helpers');

module.exports = function applyReferralSchema(db) {
  // One code per account, chosen by the account holder. The code is stored
  // uppercase and carries a UNIQUE index, which is what makes duplicates
  // impossible regardless of how many people try to claim the same name at
  // once — the second INSERT simply fails.
  //
  // `is_influencer` marks a content-creator partnership; the two override
  // columns let one creator be given better terms than the site default
  // without changing anything for everyone else. NULL means "use the global
  // setting", which is different from 0 ("this creator earns nothing").
  run(db, 'referral_codes table', `CREATE TABLE IF NOT EXISTS referral_codes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    is_influencer BOOLEAN NOT NULL DEFAULT FALSE,
    bonus_percent_override REAL,
    commission_percent_override REAL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  // Uppercase is enforced on write, but a case-insensitive index means a
  // lookup can never be defeated by a casing trick either. Postgres has no
  // NOCASE collation, so the index is on LOWER(code) — the lookup in
  // getReferralCodeByCode is written to match it exactly, which is what lets
  // the planner use it.
  run(db, 'referral code index',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code_nocase
     ON referral_codes (LOWER(code))`);

  // Who referred whom. UNIQUE on referee_user_id makes the binding permanent
  // and singular: a customer belongs to exactly one creator, forever, and
  // cannot be re-attributed to whoever is running the best promo this week.
  run(db, 'referral_attributions table', `CREATE TABLE IF NOT EXISTS referral_attributions (
    id SERIAL PRIMARY KEY,
    referee_user_id INTEGER NOT NULL UNIQUE,
    referral_code_id INTEGER NOT NULL,
    referrer_user_id INTEGER NOT NULL,
    bound_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referee_user_id) REFERENCES users (id),
    FOREIGN KEY (referral_code_id) REFERENCES referral_codes (id)
  )`);

  // One row per referred order. `order_id` is UNIQUE, which is the structural
  // guarantee that a single top-up can never pay a creator twice — the same
  // shape of protection the receipts table uses for bank transfers.
  //
  // status is 'pending' until the order is genuinely delivered. Only
  // 'credited' rows count towards a balance, so an approved-but-undelivered
  // order — or one that later fails — never pays anyone.
  run(db, 'referral_earnings table', `CREATE TABLE IF NOT EXISTS referral_earnings (
    id SERIAL PRIMARY KEY,
    referral_code_id INTEGER NOT NULL,
    referrer_user_id INTEGER NOT NULL,
    referee_user_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL UNIQUE,
    order_robux INTEGER NOT NULL,
    bonus_robux INTEGER NOT NULL DEFAULT 0,
    commission_robux INTEGER NOT NULL DEFAULT 0,
    bonus_percent REAL NOT NULL DEFAULT 0,
    commission_percent REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    credited_at TIMESTAMPTZ,
    FOREIGN KEY (referral_code_id) REFERENCES referral_codes (id),
    FOREIGN KEY (order_id) REFERENCES game_passes (id)
  )`);

  run(db, 'referral earnings index',
    `CREATE INDEX IF NOT EXISTS idx_referral_earnings_code
     ON referral_earnings (referral_code_id, status)`);

  // Robux actually handed over to a creator. Balance owed is credited
  // earnings minus these, so a payout is recorded rather than deducted from
  // the earnings rows themselves — that keeps the earnings ledger an
  // unmodified history of what was earned.
  run(db, 'referral_payouts table', `CREATE TABLE IF NOT EXISTS referral_payouts (
    id SERIAL PRIMARY KEY,
    referral_code_id INTEGER NOT NULL,
    referrer_user_id INTEGER NOT NULL,
    robux_amount INTEGER NOT NULL,
    note TEXT,
    admin_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referral_code_id) REFERENCES referral_codes (id)
  )`);

  // Defaults. Percentages are deliberately conservative; all are editable
  // from the admin dashboard.
  seedSettings(db, [
    ['referral_enabled', '1'],
    // What the customer gets: extra Robux on top of what they paid for.
    ['referral_bonus_percent', '5'],
    // What the creator earns per referred order, as a % of its Robux.
    ['referral_commission_percent', '10'],
    // 'every_order' or 'first_order' — how long the customer's bonus lasts.
    ['referral_bonus_scope', 'every_order'],
    // 0 = uncapped. A ceiling on the customer bonus per order.
    ['referral_max_bonus_robux', '0'],
    // Only customers with no completed orders may bind a code, so an
    // established customer can't be retro-attributed to a creator.
    ['referral_new_customers_only', '1'],
    ['referral_min_payout_robux', '100']
  ]);
};
