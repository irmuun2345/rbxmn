// Administrator accounts and their credentials.
module.exports = (db) => ({
  // Create admin
  createAdmin: (username, passwordHash, callback) => {
    const sql = `INSERT INTO admins (username, password_hash) VALUES (?, ?)`;
    db.run(sql, [username, passwordHash], function(err) {
      if (err) {
        callback(err, null);
      } else {
        callback(null, { id: this.lastID, username });
      }
    });
  },

  // Get admin by username
  getAdminByUsername: (username, callback) => {
    const sql = `SELECT * FROM admins WHERE username = ?`;
    db.get(sql, [username], (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    });
  },

  getAdminCount: (callback) => {
    db.get(`SELECT COUNT(*) AS count FROM admins`, [], (err, row) => {
      callback(err, err ? null : Number(row.count));
    });
  },

  updateAdminPassword: (id, passwordHash, callback) => {
    db.run(`UPDATE admins SET password_hash = ? WHERE id = ?`, [passwordHash, id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  },
});
