// An isolated, throwaway database for a single test.
//
// Tests that exercise the schema need their own database rather than the
// shared connection, because they boot applySchema repeatedly and assert on
// what a *fresh* install produces.
//
// This used to hand back a sqlite3 file in os.tmpdir(). It is PGlite now —
// real Postgres compiled to WASM, in-process and in-memory — because the
// schema and every repository are written in Postgres dialect. A SQLite
// database here would be testing SQL the application no longer runs.
//
// In-memory means there is no file to lock, so the Windows EPERM dance the
// old helper needed on close is gone too.

const { PGlite } = require('@electric-sql/pglite');
const { createAdapter } = require('../../src/models/pg-adapter');

function temporaryDatabase() {
  const client = new PGlite();
  return createAdapter(client, () => client.close());
}

const run = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, (error) => (error ? reject(error) : resolve()));
});

const all = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
});

async function discard(db) {
  await new Promise((resolve) => db.close(() => resolve()));
}

// applySchema returns before its work is done, and offers no completion
// signal: it queues statements, some of which are queued by the *callbacks*
// of earlier ones — importLegacyAccount in schema/banking.js reads settings,
// and only then decides on the INSERT.
//
// ready() drains everything queued so far, which is one such wave. It cannot
// see work that does not exist yet, so a nested queue needs another pass.
// Three covers the deepest nesting in schema/ and still beats sleeping on a
// guessed interval.
async function settle(db) {
  for (let wave = 0; wave < 3; wave += 1) {
    await db.ready();
  }
}

module.exports = { temporaryDatabase, run, all, discard, settle };
