// What the storefront sells: fixed Robux packages and time-boxed bonus
// events.

const { run } = require('./helpers');

module.exports = function applyCatalogSchema(db) {
  // Customers can only buy or gift these exact amounts, never a free-typed
  // quantity — which is what makes every order's price a lookup rather than
  // something the client can propose. price_mnt is the admin-set price;
  // discount_percent is a manually-toggled markdown applied on top of it.
  run(db, 'packages table', `CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    robux_amount INTEGER NOT NULL,
    price_mnt INTEGER NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seeded only into an empty table: an admin who deliberately deleted every
  // package should not find them back after a restart.
  db.get('SELECT COUNT(*) AS count FROM packages', [], (error, row) => {
    if (error || !row || row.count > 0) return;
    run(db, 'default packages',
      `INSERT INTO packages (robux_amount, price_mnt, sort_order) VALUES
        (400, 18000, 1), (800, 36000, 2), (1700, 76500, 3)`);
  });

  // A percentage of extra Robux applied on top of what a customer pays for
  // while the window is open.
  run(db, 'events table', `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    bonus_percent REAL NOT NULL,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
};
