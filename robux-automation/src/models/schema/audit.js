// Append-only record of every consequential action: who did what, to which
// entity, when.
//
// Deliberately has no UPDATE or DELETE helper anywhere in the data layer — an
// audit trail that can be edited answers no question worth asking.

const { run } = require('./helpers');

module.exports = function applyAuditSchema(db) {
  // actor_type is 'admin' for a human action and 'system' for one the
  // background poller took on its own, which is the distinction that matters
  // when reconstructing how an order reached its current state.
  run(db, 'audit_log table', `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // The log is read newest-first, and filtered by entity when investigating
  // one order.
  run(db, 'audit_log time index',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC)');
  run(db, 'audit_log entity index',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id)');
};
