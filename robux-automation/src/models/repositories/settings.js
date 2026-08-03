// Free-form key/value configuration.
module.exports = (db) => ({
  getSetting: (key, callback) => {
    db.get(`SELECT value, updated_at FROM settings WHERE key = ?`, [key], callback);
  },

  setSetting: (key, value, callback) => {
    const sql = `INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`;
    db.run(sql, [key, value], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },
});
