// Accounts, and the lifetime-purchase totals the loyalty level is derived from.
//
// Both totals below filter on ORDER_STATUS.COMPLETED — a delivered order, not
// a paid one — so nothing counts towards a discount or a "new customer" check
// until the Robux have actually arrived.
const { ORDER_STATUS } = require('../../services/order-status');

module.exports = (db) => ({
  // Create a new user
  createUser: (username, robloxId, callback) => {
    const sql = `INSERT INTO users (username, roblox_id) VALUES (?, ?)`;
    db.run(sql, [username, robloxId], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID, username, robloxId });
      }
    });
  },

  // Get user by username
  getUserByUsername: (username, callback) => {
    const sql = `SELECT * FROM users WHERE username = ?`;
    db.get(sql, [username], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  // Get user by ID
  getUserById: (id, callback) => {
    const sql = `SELECT * FROM users WHERE id = ?`;
    db.get(sql, [id], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  // Get user by their stable Roblox account ID
  getUserByRobloxId: (robloxId, callback) => {
    const sql = `SELECT * FROM users WHERE roblox_id = ?`;
    db.get(sql, [robloxId], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  // Lifetime Robux a user has actually paid for and received — the only
  // number levels are ever computed from, so it can't be spoofed by the client.
  getUserPurchasedTotal: (userId, callback) => {
    db.get(
      `SELECT COALESCE(SUM(price), 0) AS total FROM game_passes WHERE user_id = ? AND status = ?`,
      [userId, ORDER_STATUS.COMPLETED],
      (err, row) => callback(err, err ? null : Number(row.total))
    );
  },

  // Whether this account has ever actually received a top-up. Used to gate
  // binding a code to genuinely new customers.
  getUserCompletedOrderCount: (userId, callback) => {
    db.get(
      `SELECT COUNT(*) AS count FROM game_passes WHERE user_id = ? AND status = ?`,
      [userId, ORDER_STATUS.COMPLETED],
      (err, row) => callback(err, err ? null : Number(row.count))
    );
  },

  // ---------------------------------------------------------------------
  // Audit log (append-only)
  // ---------------------------------------------------------------------
});
