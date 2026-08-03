// Table creation and in-place migrations, run once at startup.
//
// Everything here is idempotent: booting against an existing database is a
// no-op, booting against an empty one builds the whole schema.
//
// ORDER MATTERS, and in exactly one way: `settings` has to exist before
// anything seeds a row into it. core.js creates that table, so it goes first
// and every file that calls seedSettings() goes after it.
//
// This used to be one 630-line function, and the ordering constraint was
// invisible inside it — the referral and group-membership defaults were in
// fact being INSERTed several hundred lines *before* the CREATE TABLE, so a
// brand-new install silently started with none of them. Splitting the file
// made that a one-line fix and, more usefully, made it hard to reintroduce.
//
// Adding a domain means adding a file and one line to MIGRATIONS.
const MIGRATIONS = [
  require('./core'),        // users, sessions, admins, seller bots, settings
  require('./orders'),      // orders (game_passes) and transactions
  require('./catalog'),     // packages and bonus events
  require('./payments'),    // gateway confirmations and uploaded receipts
  require('./gift-cards'),
  require('./referrals'),
  require('./identity'),    // phone links and group-membership clocks
  require('./audit')
];

module.exports = function applySchema(db) {
  // One serialize for the whole run, so statements execute in the order they
  // are queued rather than racing each other.
  db.serialize(() => {
    MIGRATIONS.forEach((apply) => apply(db));
  });
};
