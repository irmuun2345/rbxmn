// Append-only. There is deliberately no update or delete helper here.
module.exports = (db) => ({
  appendAuditLog: (entry, callback) => {
    const sql = `INSERT INTO audit_log
      (actor_type, actor_id, actor_name, action, entity_type, entity_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [
      entry.actorType,
      entry.actorId ?? null,
      entry.actorName ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ipAddress ?? null
    ], function(err) {
      callback(err, err ? null : { id: this.lastID });
    });
  },

  // Filterable, paged listing for the admin audit view.
  getAuditLog: ({ action, entityType, entityId, actorType, limit, offset }, callback) => {
    const conditions = [];
    const params = [];

    if (action) { conditions.push('action = ?'); params.push(action); }
    if (actorType) { conditions.push('actor_type = ?'); params.push(actorType); }
    if (entityType) { conditions.push('entity_type = ?'); params.push(entityType); }
    if (entityId) { conditions.push('entity_id = ?'); params.push(entityId); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    db.all(sql, [...params, Number(limit) || 100, Number(offset) || 0], callback);
  },

  getAuditLogCount: (callback) => {
    db.get(`SELECT COUNT(*) AS count FROM audit_log`, [], (err, row) => {
      callback(err, err ? null : Number(row.count));
    });
  },

  // ---------------------------------------------------------------------
  // Group membership (the 14-day payout clock)
  // ---------------------------------------------------------------------
});
