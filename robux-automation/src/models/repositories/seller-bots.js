// The Roblox account that accepts group joins and sends payouts.
module.exports = (db) => ({
  // Create seller bot
  createSellerBot: (adminId, username, robloxId, cookie, callback) => {
    const sql = `INSERT INTO seller_bots (admin_id, username, roblox_id, cookie, is_active) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [adminId, username, robloxId, cookie, true], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID, adminId, username, robloxId, is_active: true });
      }
    });
  },

  // Get seller bots by admin ID
  getSellerBotsByAdminId: (adminId, callback) => {
    const sql = `SELECT * FROM seller_bots WHERE admin_id = ?`;
    db.all(sql, [adminId], (err, rows) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, rows);
      }
    });
  },

  // Add or replace the bot account used for group join/payout automation
  upsertSellerBot: (adminId, username, robloxId, cookie, callback) => {
    const sql = `INSERT INTO seller_bots (admin_id, username, roblox_id, cookie, is_active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(username) DO UPDATE SET
        admin_id = excluded.admin_id,
        roblox_id = excluded.roblox_id,
        cookie = excluded.cookie,
        is_active = 1`;
    db.run(sql, [adminId, username, robloxId, cookie], function(err) {
      callback(err, err ? null : { id: this.lastID, adminId, username, robloxId });
    });
  },

  deactivateAllSellerBots: (callback) => {
    db.run(`UPDATE seller_bots SET is_active = 0`, [], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  getActiveSellerBot: (callback) => {
    db.get(`SELECT * FROM seller_bots WHERE is_active = 1 ORDER BY id DESC LIMIT 1`, [], (err, row) => {
      callback(err, err ? null : row);
    });
  },

  // Get seller bot by ID
  getSellerBotById: (id, callback) => {
    const sql = `SELECT * FROM seller_bots WHERE id = ?`;
    db.get(sql, [id], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  // Update seller bot cookie
  updateSellerBotCookie: (id, cookie, callback) => {
    const sql = `UPDATE seller_bots SET cookie = ? WHERE id = ?`;
    db.run(sql, [cookie, id], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { changes: this.changes });
      }
    });
  },

  // Deactivate seller bot
  deactivateSellerBot: (id, callback) => {
    const sql = `UPDATE seller_bots SET is_active = FALSE WHERE id = ?`;
    db.run(sql, [id], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { changes: this.changes });
      }
    });
  },
});
