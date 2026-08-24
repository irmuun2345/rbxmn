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
      `SELECT * FROM bank_accounts WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC`,
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
      [bankName, accountNumber, accountHolder, Boolean(isActive), id],
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

  // Rewrites the whole ordering from a list of ids.
  //
  // One statement, so a half-applied reorder cannot leave two accounts
  // claiming the same position. This used to be one UPDATE per id wrapped in
  // BEGIN IMMEDIATE / COMMIT, which is not safe over a connection pool: each
  // statement is checked out independently, so the BEGIN, the updates and the
  // COMMIT could each land on a different backend — the transaction would
  // guard nothing and the COMMIT would close an empty one.
  //
  // unnest(...) WITH ORDINALITY turns the id array into (id, position) rows
  // the UPDATE can join against. A single statement is atomic on its own, so
  // no explicit transaction is needed. WITH ORDINALITY counts from 1 and the
  // old loop counted from 0; sort_order is only ever compared, never read as
  // a value, but the -1 keeps the stored numbers identical to before.
  reorderBankAccounts: (orderedIds, callback) => {
    const sql = `UPDATE bank_accounts
      SET sort_order = ranked.position - 1
      FROM (SELECT * FROM unnest(?::int[]) WITH ORDINALITY AS t(id, position)) AS ranked
      WHERE bank_accounts.id = ranked.id`;

    db.run(sql, [orderedIds], function reorder(error) {
      callback(error, error ? null : { ordered: this.changes });
    });
  }
});
