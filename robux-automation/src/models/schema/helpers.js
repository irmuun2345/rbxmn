// Shared plumbing for the migration files in this folder.
//
// Every statement is idempotent — CREATE TABLE / CREATE INDEX IF NOT EXISTS,
// INSERT OR IGNORE, and ALTER TABLE guarded by a PRAGMA read — so booting
// against an existing database is a no-op and booting against an empty one
// builds the whole schema.

// Failures are logged, never thrown.
//
// A migration that cannot apply is worth shouting about, but killing the
// process would take the storefront down over a problem that is usually
// confined to one table. `label` is what the operator reads at 3am, so it
// names the thing being built rather than the SQL.
function run(db, label, sql, params = []) {
  db.run(sql, params, (error) => {
    if (error) console.error(`Schema: ${label} failed:`, error.message);
  });
}

/**
 * Adds any of `columns` the table does not already have.
 *
 * SQLite has no "ADD COLUMN IF NOT EXISTS", so the existing columns are read
 * first and the ALTERs are issued for the difference.
 *
 * @param {import('sqlite3').Database} db
 * @param {string} table
 * @param {Array<[string, string]>} columns  [name, SQL type + constraints]
 * @param {(db: import('sqlite3').Database) => void} [afterwards]  runs once
 *        the ALTERs are queued — for backfills that need the new columns
 */
function addMissingColumns(db, table, columns, afterwards) {
  db.all(`PRAGMA table_info(${table})`, (error, existingColumns) => {
    if (error) {
      console.error(`Schema: reading ${table} columns failed:`, error.message);
      return;
    }

    // This callback fires long after the enclosing db.serialize() block has
    // returned, so the connection is back in parallel mode by now. Without
    // re-serializing, the statements below race their own ALTER TABLEs and a
    // backfill hits a column that does not exist yet.
    db.serialize(() => {
      const existing = new Set(existingColumns.map((column) => column.name));
      columns
        .filter(([name]) => !existing.has(name))
        .forEach(([name, definition]) => {
          run(db, `${table}.${name}`, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        });
      if (afterwards) afterwards(db);
    });
  });
}

// Default values for the settings table. Existing rows are never overwritten,
// so an admin's edit always survives a restart.
//
// The settings table must already exist when this runs — see the ordering
// note in index.js.
function seedSettings(db, entries) {
  entries.forEach(([key, value]) => {
    run(db, `setting ${key}`, 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  });
}

module.exports = { run, addMissingColumns, seedSettings };
