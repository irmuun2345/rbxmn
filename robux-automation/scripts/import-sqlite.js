#!/usr/bin/env node

// One-time copy of an existing SQLite database into Postgres.
//
// The app moved from a SQLite file to Postgres so it could run on Vercel,
// where the filesystem does not survive between requests. That change does
// nothing for an install that already has customers, orders and audit history
// in src/models/robux.db — this script carries that data across.
//
//   npm run migrate                      # build the Postgres schema first
//   node scripts/import-sqlite.js        # then copy the rows in
//
// Safe to think about, harder to undo: it appends into whatever is already
// there. Run it against a fresh, migrated database, and only once. It refuses
// to start if the target already holds rows, so a second run has to be a
// deliberate act (--force) rather than an accident.
//
// Usage:
//   node scripts/import-sqlite.js [path/to/robux.db] [--force] [--dry-run]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });

const sqlite3 = require('sqlite3');
const { db: target, driver } = require('../src/models/db');

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const sourcePath = args.find((a) => !a.startsWith('--'))
  || path.join(__dirname, '../src/models/robux.db');

// Parent before child, so a foreign key never points at a row that has not
// been written yet.
//
// `sessions` and `express_sessions` are deliberately absent. Both hold
// short-lived auth state — an in-flight OAuth handshake, a logged-in browser
// — that expires within a day and means nothing on a different deployment.
// Copying them would migrate a set of live login cookies, which is a thing
// worth not doing.
const TABLE_ORDER = [
  'users',
  'admins',
  'seller_bots',
  'settings',
  'packages',
  'events',
  'bank_accounts',
  'game_passes',
  'transactions',
  'payments',
  'receipts',
  'gift_cards',
  'phone_links',
  'group_memberships',
  'referral_codes',
  'referral_attributions',
  'referral_earnings',
  'referral_payouts',
  'audit_log'
];

const source = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY);

const sqliteAll = (sql, params = []) => new Promise((resolve, reject) => {
  source.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
});

const pgAll = (sql, params = []) => new Promise((resolve, reject) => {
  target.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
});

const pgRun = (sql, params = []) => new Promise((resolve, reject) => {
  target.run(sql, params, function done(error) {
    if (error) reject(error);
    else resolve({ changes: this.changes });
  });
});

// What Postgres thinks each column is, so values can be coerced to match.
// Read from the live target rather than hardcoded: the schema is the
// authority on its own types, and a list here would rot the first time a
// column changed.
async function describe(table) {
  const rows = await pgAll(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ?`,
    [table]
  );
  return new Map(rows.map((row) => [row.column_name, row.data_type]));
}

// The primary key of a table, in order, so a conflict can be resolved by
// overwriting rather than skipped.
async function primaryKeyColumns(table) {
  const rows = await pgAll(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = ?::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)`,
    [table]
  );
  return rows.map((row) => row.column_name);
}

// SQLite has no boolean and no date type: it stored 0/1 and ISO-ish strings.
// Postgres has both and will reject the raw values, so each one is converted
// according to what the destination column actually is.
function coerce(value, dataType) {
  if (value === null || value === undefined) return null;

  if (dataType === 'boolean') {
    // SQLite wrote 0/1; be generous about what else might be in there.
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).toLowerCase();
    return text === '1' || text === 'true' || text === 't';
  }

  if (dataType === 'timestamp with time zone' || dataType === 'timestamp without time zone') {
    // Either "2026-07-31T03:04:38.087Z" or "2026-07-31 04:04:38". Postgres
    // parses both, but a number would be read as a year, so epoch
    // milliseconds are converted explicitly.
    if (typeof value === 'number') return new Date(value).toISOString();
    return String(value);
  }

  if (dataType === 'bigint' || dataType === 'integer' || dataType === 'smallint') {
    return typeof value === 'number' ? value : Number(value);
  }

  return value;
}

async function copyTable(table) {
  const columnTypes = await describe(table);
  if (columnTypes.size === 0) {
    console.log(`  ${table.padEnd(24)} skipped (no such table in Postgres)`);
    return 0;
  }

  let rows;
  try {
    rows = await sqliteAll(`SELECT * FROM "${table}"`);
  } catch (error) {
    console.log(`  ${table.padEnd(24)} skipped (not in the SQLite file)`);
    return 0;
  }

  if (rows.length === 0) {
    console.log(`  ${table.padEnd(24)} 0`);
    return 0;
  }

  // Only columns that exist on both sides. A column the old database never
  // had is left to its Postgres default; one Postgres dropped is ignored.
  const columns = Object.keys(rows[0]).filter((name) => columnTypes.has(name));
  const placeholders = columns.map(() => '?').join(', ');
  const quoted = columns.map((name) => `"${name}"`).join(', ');

  // Upsert on the primary key, not DO NOTHING.
  //
  // `npm run migrate` seeds defaults — three packages and a dozen settings
  // rows — so the target is never truly empty. With DO NOTHING those seeded
  // defaults win every collision, and the migration silently discards exactly
  // the rows an operator most cares about: their real prices, their real
  // package list. Overwriting is right because the SQLite file is the
  // authority here; that also makes an interrupted run safe to repeat.
  const primaryKey = await primaryKeyColumns(table);
  const updatable = columns.filter((name) => !primaryKey.includes(name));

  let conflictClause = ' ON CONFLICT DO NOTHING';
  if (primaryKey.length > 0 && updatable.length > 0) {
    const target = primaryKey.map((name) => `"${name}"`).join(', ');
    const assignments = updatable.map((name) => `"${name}" = EXCLUDED."${name}"`).join(', ');
    conflictClause = ` ON CONFLICT (${target}) DO UPDATE SET ${assignments}`;
  }

  const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})${conflictClause}`;

  let written = 0;
  for (const row of rows) {
    const values = columns.map((name) => coerce(row[name], columnTypes.get(name)));
    if (dryRun) {
      written += 1;
      continue;
    }
    try {
      const result = await pgRun(sql, values);
      written += result.changes;
    } catch (error) {
      console.error(`  ${table}: row failed — ${error.message}`);
    }
  }

  console.log(`  ${table.padEnd(24)} ${written}${written === rows.length ? '' : ` of ${rows.length}`}`);
  return written;
}

// Rows were inserted with their original ids, which leaves each SERIAL
// sequence still sitting at 1. Without this, the very next insert would try
// to reuse id 1 and fail on the primary key — the classic "imported fine,
// then everything broke" outcome.
async function resyncSequences() {
  const sequences = await pgAll(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_default LIKE 'nextval%'`
  );

  for (const { table_name: table, column_name: column } of sequences) {
    if (dryRun) continue;
    try {
      // setval to the current maximum, or leave it at 1 for an empty table.
      // `false` on an empty table means the next value handed out is 1 rather
      // than 2.
      await pgRun(
        `SELECT setval(
           pg_get_serial_sequence('${table}', '${column}'),
           COALESCE((SELECT MAX("${column}") FROM "${table}"), 1),
           (SELECT MAX("${column}") IS NOT NULL FROM "${table}")
         )`
      );
    } catch (error) {
      console.error(`  sequence for ${table}.${column} failed: ${error.message}`);
    }
  }
  console.log(`  ${sequences.length} sequence(s) resynced`);
}

async function main() {
  if (driver !== 'postgres') {
    console.error(
      'FATAL: DATABASE_URL is not set, so the target would be a throwaway in-memory database.\n'
      + '  Set DATABASE_URL to the Postgres server you are importing into.'
    );
    process.exit(1);
  }

  console.log(`Source: ${sourcePath}`);
  console.log(`Target: Postgres${dryRun ? '  (DRY RUN — nothing will be written)' : ''}\n`);

  // Importing on top of live data would duplicate every row that does not
  // happen to collide on a unique index.
  if (!force && !dryRun) {
    const [{ count }] = await pgAll('SELECT COUNT(*) AS count FROM users');
    if (count > 0) {
      console.error(
        `FATAL: the target already holds ${count} user(s).\n`
        + '  This script appends, so running it now would duplicate data.\n'
        + '  Use --dry-run to see what it would copy, or --force if you are sure.'
      );
      process.exit(1);
    }
  }

  console.log('Copying tables:');
  let total = 0;
  for (const table of TABLE_ORDER) {
    total += await copyTable(table);
  }

  console.log('\nResyncing id sequences:');
  await resyncSequences();

  console.log(`\nDone — ${total} row(s) ${dryRun ? 'would be ' : ''}copied.`);

  await new Promise((resolve) => source.close(resolve));
  await new Promise((resolve) => target.close(resolve));
  process.exit(0);
}

main().catch((error) => {
  console.error('FATAL: import failed:', error.message);
  process.exit(1);
});
