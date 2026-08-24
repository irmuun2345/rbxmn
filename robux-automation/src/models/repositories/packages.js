// The fixed Robux packages — the only amounts a customer can buy or gift.
module.exports = (db) => ({
  createPackage: (robuxAmount, priceMnt, discountPercent, sortOrder, callback) => {
    const sql = `INSERT INTO packages (robux_amount, price_mnt, discount_percent, sort_order) VALUES (?, ?, ?, ?)`;
    db.run(sql, [robuxAmount, priceMnt, discountPercent, sortOrder], function(err) {
      callback(err, err ? null : { id: this.lastID });
    });
  },

  getPackages: (activeOnly, callback) => {
    const sql = activeOnly
      ? `SELECT * FROM packages WHERE is_active = TRUE ORDER BY sort_order ASC, robux_amount ASC`
      : `SELECT * FROM packages ORDER BY sort_order ASC, robux_amount ASC`;
    db.all(sql, [], callback);
  },

  getPackageById: (id, callback) => {
    db.get(`SELECT * FROM packages WHERE id = ?`, [id], callback);
  },

  updatePackage: (id, robuxAmount, priceMnt, discountPercent, isActive, sortOrder, callback) => {
    const sql = `UPDATE packages SET robux_amount = ?, price_mnt = ?, discount_percent = ?, is_active = ?, sort_order = ? WHERE id = ?`;
    db.run(sql, [robuxAmount, priceMnt, discountPercent, Boolean(isActive), sortOrder, id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  deletePackage: (id, callback) => {
    db.run(`DELETE FROM packages WHERE id = ?`, [id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },

  // ---------------------------------------------------------------------
  // Referrals
  // ---------------------------------------------------------------------
});
