// The bank accounts shown on the payment panel.
//
// Order matters to the buyer — the first account listed is the one most people
// will use — so `sort_order` is part of every read, and new accounts go to the
// end rather than jumping the queue.
module.exports = (db) => ({
  // What the storefront quotes. Deactivated accounts stay in the table so an
  // old receipt still resolves to a name, but they are never offered again.
  listActiveBankAccounts: (callback) => {
    db.all(
      `SELECT * FROM bank_accounts WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`,
      [],
      (error, rows) => callback(error, error ? null : rows)
    );
  },

  // What the dashboard edits, deactivated rows included.
  listAllBankAccounts: (callback) => {
    db.all(
      `SELECT * FROM bank_accounts ORDER BY sort_order ASC, id ASC`,
      [],
      (error, rows) => callback(error, error ? null : rows)
    );
  },

  getBankAccountById: (id, callback) => {
    db.get(`SELECT * FROM bank_accounts WHERE id = ?`, [id], (error, row) => (
      callback(error, error ? null : row)
    ));
  },

  // Appended after whatever is already there. COALESCE covers the empty table,
  // where MAX() is null rather than 0.
  createBankAccount: (bankName, accountNumber, accountHolder, callback) => {
    db.run(
      `INSERT INTO bank_accounts (bank_name, account_number, account_holder, sort_order)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM bank_accounts))`,
      [bankName, accountNumber, accountHolder],
      function insert(error) {
        callback(error, error ? null : { id: this.lastID, bankName, accountNumber, accountHolder });
      }
    );
  },

  updateBankAccountRow: (id, { bankName, accountNumber, accountHolder, isActive }, callback) => {
    db.run(
      `UPDATE bank_accounts
          SET bank_name = ?, account_number = ?, account_holder = ?, is_active = ?
        WHERE id = ?`,
      [bankName, accountNumber, accountHolder, isActive ? 1 : 0, id],
      function update(error) {
        callback(error, error ? null : { changes: this.changes });
      }
    );
  },

  deleteBankAccount: (id, callback) => {
    db.run(`DELETE FROM bank_accounts WHERE id = ?`, [id], function remove(error) {
      callback(error, error ? null : { changes: this.changes });
    });
  },

  // Rewrites the whole ordering from a list of ids. Done as one statement per
  // id inside a transaction so a half-applied reorder cannot leave two
  // accounts claiming the same position.
  reorderBankAccounts: (orderedIds, callback) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', (beginError) => {
        if (beginError) return callback(beginError, null);

        let failure = null;
        orderedIds.forEach((id, index) => {
          db.run(
            `UPDATE bank_accounts SET sort_order = ? WHERE id = ?`,
            [index, id],
            (error) => { failure = failure || error; }
          );
        });

        db.run(failure ? 'ROLLBACK' : 'COMMIT', (endError) => {
          callback(failure || endError, failure || endError ? null : { ordered: orderedIds.length });
        });
      });
    });
  }
});
