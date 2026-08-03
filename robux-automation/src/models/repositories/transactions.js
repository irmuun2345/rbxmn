// The historical ledger rows shown on a buyer's profile.
module.exports = (db) => ({
  // Create a transaction
  createTransaction: (gamepassId, buyerId, sellerId, amount, robloxTransactionId, callback) => {
    const sql = `INSERT INTO transactions (gamepass_id, buyer_id, seller_id, amount, roblox_transaction_id) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [gamepassId, buyerId, sellerId, amount, robloxTransactionId], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID, gamepassId, buyerId, sellerId, amount, robloxTransactionId });
      }
    });
  },

  // Get transactions by user ID
  getTransactionsByUserId: (userId, callback) => {
    const sql = `SELECT * FROM transactions WHERE buyer_id = ? OR seller_id = ?`;
    db.all(sql, [userId, userId], (err, rows) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, rows);
      }
    });
  },
});
