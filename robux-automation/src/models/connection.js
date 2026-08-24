const { createAdapter } = require('./pg-adapter');

// node-postgres hands back int8 (BIGINT) as a *string*, because a 64-bit
// integer does not always fit a JS number. Two kinds of value in this schema
// come back as int8: COUNT(*) results, and the epoch-millisecond expiry
// columns on `sessions` and `express_sessions`.
//
// Left as strings both are quietly wrong rather than loudly broken —
// `row.count > 0` on "0" is fine but `counts[status] + 1` becomes "01", and a
// caller comparing two expiry strings compares them lexically. Every int8
// this app produces is a count or a timestamp, far below 2^53, so parsing
// them as numbers is safe and restores exactly the shape the callers were
// written against.
require('pg').types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

// The single connection every repository shares.
//
// Kept in its own module so that requiring the connection does not drag in
// the schema or all 95 helpers — and so there is exactly one place that
// decides where the database lives.
//
// This used to open a SQLite file. It no longer can: on Vercel the
// filesystem is per-invocation and ephemeral, so a file database loses every
// order and payment between requests. Postgres is now the only store.
//
// Two drivers, one dialect:
//
//   DATABASE_URL set   -> node-postgres against the real server (Neon in
//                         production). Pooled, and on Vercel that pool is
//                         sized for a serverless function, not a long-lived
//                         box — see MAX_CLIENTS.
//   DATABASE_URL unset -> PGlite, real Postgres compiled to WASM, running
//                         in-process. Local development and `npm test` need
//                         no database server, and every statement still goes
//                         through the same dialect as production.
//
// The point of PGlite over the old SQLite file is that dev and prod no
// longer disagree about SQL. A query that works locally works deployed.

const connectionString = process.env.DATABASE_URL;

// Serverless functions each hold their own pool, and a Postgres server has a
// global connection ceiling. One client per function instance is the setting
// that does not exhaust it — the adapter serializes queries anyway, so a
// larger pool would sit idle. Neon's pooled (pgbouncer) endpoint handles the
// fan-in across instances.
const MAX_CLIENTS = Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 1 : 10));

let db;
let driver;

if (connectionString) {
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString,
    max: MAX_CLIENTS,
    // A serverless instance is frozen between invocations; a socket it left
    // open is usually dead by the time it thaws. Short timeouts mean a stale
    // connection is discarded rather than handed to a query that then hangs.
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    // Neon and Vercel Postgres require TLS. `rejectUnauthorized: false`
    // matches what their own connection strings ask for; set PGSSLMODE=
    // disable for a local server that has no certificate.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });

  // An idle client erroring out must not take the process down. The pool
  // discards it and the next query gets a fresh one.
  pool.on('error', (error) => {
    console.error('Postgres pool error:', error.message);
  });

  driver = 'postgres';
  db = createAdapter(pool, () => pool.end());
  console.log('Connected to Postgres.');
} else {
  // PGlite is a devDependency: it is the local/test database and has no place
  // in a production bundle. Reaching here on a deployment therefore means
  // DATABASE_URL was never set, and the raw MODULE_NOT_FOUND that follows
  // says nothing about the actual mistake.
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (error) {
    console.error(
      'FATAL: DATABASE_URL is not set and the in-process fallback database is unavailable.\n'
      + '  Set DATABASE_URL to your Postgres connection string (Neon, Vercel Postgres, or\n'
      + '  any other Postgres server). It is required in production.'
    );
    throw error;
  }

  // In-memory unless PGLITE_PATH names a directory, so a test run starts
  // from an empty database and leaves nothing behind. Point PGLITE_PATH at a
  // folder for local development that should survive a restart.
  const client = new PGlite(process.env.PGLITE_PATH || undefined);

  driver = 'pglite';
  db = createAdapter(client, () => client.close());
  console.log(
    'Connected to in-process PGlite'
    + (process.env.PGLITE_PATH ? ` (persisted at ${process.env.PGLITE_PATH}).` : ' (in-memory).')
  );
}

module.exports = { db, driver };
