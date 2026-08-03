// Accounts, sessions and the settings key/value store.
//
// Runs first. `settings` in particular has to exist before any other file
// seeds a default into it — see the ordering note in index.js.

const { run, seedSettings } = require('./helpers');

module.exports = function applyCoreSchema(db) {
  run(db, 'users table', `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    roblox_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  run(db, 'sessions table', `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    session_data TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  run(db, 'admins table', `CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // The Roblox account the bot operates as. `cookie` is a full Roblox session
  // token, which is why nothing outside src/services ever reads this column
  // and no route returns it.
  run(db, 'seller_bots table', `CREATE TABLE IF NOT EXISTS seller_bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    username TEXT UNIQUE NOT NULL,
    roblox_id INTEGER UNIQUE,
    cookie TEXT,
    is_active BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins (id)
  )`);

  run(db, 'settings table', `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
