// Recognising a database error by kind rather than by wording.
//
// Several places in this app treat a unique-constraint violation as a normal,
// expected outcome rather than a failure: a retried payment webhook, a phone
// number already linked, a referral code someone else just claimed. Each of
// them used to detect it with String(error.message).includes('UNIQUE'),
// which worked because SQLite says "UNIQUE constraint failed".
//
// Postgres says "duplicate key value violates unique constraint" — lowercase.
// Every one of those checks would have silently stopped matching, and the
// failure mode is not a crash but something worse: a replayed webhook would
// have been reported as a server error instead of a recognised duplicate, and
// the "already linked" and "code taken" paths would have surfaced 500s
// instead of their real messages.
//
// SQLSTATE is the stable identifier for this, so that is what is checked.
// 23505 is unique_violation; the driver sets `code` on every error it raises.
const UNIQUE_VIOLATION = '23505';

// A foreign key pointing at a row that does not exist.
const FOREIGN_KEY_VIOLATION = '23503';

// A NOT NULL column left null.
const NOT_NULL_VIOLATION = '23502';

function isUniqueViolation(error) {
  return Boolean(error) && error.code === UNIQUE_VIOLATION;
}

function isForeignKeyViolation(error) {
  return Boolean(error) && error.code === FOREIGN_KEY_VIOLATION;
}

function isNotNullViolation(error) {
  return Boolean(error) && error.code === NOT_NULL_VIOLATION;
}

module.exports = {
  UNIQUE_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  NOT_NULL_VIOLATION,
  isUniqueViolation,
  isForeignKeyViolation,
  isNotNullViolation
};
