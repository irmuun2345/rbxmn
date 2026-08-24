// Accounts, sessions and the settings key/value store.
//
// Runs first. `settings` in particular has to exist before any other file
// seeds a default into it — see the ordering note in index.js.

const { run, addMissingColumns, seedSettings, widenToBigint } = require('./helpers');

// Named here because the session store in middleware/ needs the same name and
// two string literals that must agree is one string literal too many.
const EXPRESS_SESSION_TABLE = 'express_sessions';

module.exports = function applyCoreSchema(db) {
  run(db, 'users table', `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    roblox_id BIGINT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);

  run(db, 'sessions table', `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    session_data TEXT,
    expires_at BIGINT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  run(db, 'admins table', `CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);

  // The Roblox account the bot operates as. `cookie` is a full Roblox session
  // token, which is why nothing outside src/services ever reads this column
  // and no route returns it.
  run(db, 'seller_bots table', `CREATE TABLE IF NOT EXISTS seller_bots (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    username TEXT UNIQUE NOT NULL,
    roblox_id BIGINT UNIQUE,
    cookie TEXT,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins (id)
  )`);

  // The authenticator seed for bots with 2-step verification switched on.
  // Payouts run in a background poller with nobody watching, so a challenge
  // has to be answerable without a human — see services/totp.js.
  //
  // Held encrypted, like the cookie beside it. Added by ALTER because the
  // table above predates it.
  addMissingColumns(db, 'seller_bots', [
    ['totp_secret', 'TEXT']
  ]);

  // Roblox account ids outgrew a 32-bit integer years ago — live ids are past
  // 4.7 billion, and 2^31 is 2.1 billion.
  //
  // Under SQLite this was invisible: its INTEGER is 64-bit whatever the
  // declared type says. Postgres means it, so a column declared INTEGER
  // rejects a modern Roblox id outright with "out of range" — nobody signing
  // up today could be stored at all.
  //
  // The CREATE TABLE above says BIGINT now, but CREATE TABLE IF NOT EXISTS
  // does not alter a table that already exists, so a database built before
  // this fix needs the widening applied explicitly. Widening is lossless and
  // re-running it is a no-op.
  widenToBigint(db, 'users', 'roblox_id');
  widenToBigint(db, 'seller_bots', 'roblox_id');

  // Logged-in browser sessions, for middleware/session-store.js.
  //
  // Not to be confused with `sessions` above, which is the short-lived Roblox
  // OAuth QR handshake — different shape, different lifetime.
  //
  // Built here rather than in the store's own module, where it used to live.
  // A module-scope CREATE TABLE runs on every cold start, and concurrent cold
  // starts racing each other on it is exactly the failure db.js describes.
  //
  // expires_at is epoch milliseconds, not a timestamp — the store compares it
  // against Date.now(). BIGINT because epoch ms overflows a 32-bit INTEGER.
  run(db, 'express_sessions table', `CREATE TABLE IF NOT EXISTS ${EXPRESS_SESSION_TABLE} (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at BIGINT NOT NULL
  )`);

  run(db, 'express_sessions expiry index',
    `CREATE INDEX IF NOT EXISTS idx_express_sessions_expires
     ON ${EXPRESS_SESSION_TABLE} (expires_at)`);

  run(db, 'settings table', `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);

  seedSettings(db, [
    ['price_per_100_robux_mnt', '4500'],
    ['level_thresholds', JSON.stringify([
      { level: 1, threshold: 5000, discountPercent: 3 },
      { level: 2, threshold: 7000, discountPercent: 5 },
      { level: 3, threshold: 10000, discountPercent: 8 }
    ])]
  ]);
};

module.exports.EXPRESS_SESSION_TABLE = EXPRESS_SESSION_TABLE;
