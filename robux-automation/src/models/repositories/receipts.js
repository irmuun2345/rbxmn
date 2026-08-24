// Proof-of-transfer files. Rows only — the bytes live outside the web root.
module.exports = (db) => ({
  // Fails with a unique violation (SQLSTATE 23505) when this exact file has
  // been uploaded before, anywhere. Callers translate that into "this receipt
  // has already been used" rather than swallowing it — see receipt-controller
  // and models/db-errors.js.
  createReceipt: (receipt, callback) => {
    const sql = `INSERT INTO receipts
      (entity_type, entity_id, user_id, stored_name, original_name, mime_type, byte_size, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [
      receipt.entityType,
      receipt.entityId,
      receipt.userId,
      receipt.storedName,
      receipt.originalName,
      receipt.mimeType,
      receipt.byteSize,
      receipt.sha256
    ], function(err) {
      callback(err, err ? null : { id: this.lastID, ...receipt });
    });
  },

  getReceiptById: (id, callback) => {
    db.get(`SELECT * FROM receipts WHERE id = ?`, [id], callback);
  },

  getReceiptBySha256: (sha256, callback) => {
    db.get(`SELECT * FROM receipts WHERE sha256 = ?`, [sha256], callback);
  },

  // Newest first — a buyer whose first receipt was rejected uploads another,
  // and the admin should be looking at the latest one.
  getReceiptsForEntity: (entityType, entityId, callback) => {
    db.all(
      `SELECT * FROM receipts WHERE entity_type = ? AND entity_id = ? ORDER BY uploaded_at DESC`,
      [entityType, entityId],
      callback
    );
  },

  // ---------------------------------------------------------------------
  // Gift cards
  // ---------------------------------------------------------------------
});
