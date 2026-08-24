#!/usr/bin/env node

// Builds the schema, then exits.
//
// Run as a deploy step rather than on every boot — see the note in
// src/models/db.js for why a serverless process must not migrate itself.
//
// Idempotent, like the migrations it runs: every statement is CREATE TABLE /
// CREATE INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS, or an
// INSERT ... ON CONFLICT DO NOTHING. Running it against an up-to-date
// database changes nothing, so it is safe to wire into every build.
//
//   npm run migrate

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });

const { db, applySchema, driver } = require('../src/models/db');

// Schema failures are logged rather than thrown (see schema/helpers.js), so
// they are counted here instead: a build that could not build the schema must
// fail loudly rather than deploy an app whose tables are half-there.
let failures = 0;
const consoleError = console.error;
console.error = (...args) => {
  if (String(args[0] || '').startsWith('Schema:')) failures += 1;
  consoleError(...args);
};

async function main() {
  if (driver === 'pglite') {
    // An in-memory database created by this process and thrown away when it
    // exits — migrating it accomplishes nothing.
    console.error(
      'FATAL: DATABASE_URL is not set, so this would migrate a throwaway in-memory database.\n'
      + '  Set DATABASE_URL to the Postgres server you mean to migrate.'
    );
    process.exit(1);
  }

  console.log('Applying schema...');
  applySchema(db);

  // applySchema queues work, and some of it is queued by the callbacks of
  // earlier statements. Each ready() drains one such wave; three covers the
  // deepest nesting in schema/.
  for (let wave = 0; wave < 3; wave += 1) {
    await db.ready();
  }

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} schema statement(s) did not apply.`);
    process.exit(1);
  }

  console.log('Schema is up to date.');
  await new Promise((resolve) => db.close(resolve));
  process.exit(0);
}

main().catch((error) => {
  consoleError('FATAL: migration failed:', error.message);
  process.exit(1);
});
