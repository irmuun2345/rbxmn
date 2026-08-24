// Shared plumbing for the migration files in this folder.
//
// Every statement is idempotent — CREATE TABLE / CREATE INDEX IF NOT EXISTS,
// INSERT ... ON CONFLICT DO NOTHING, and ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS — so booting against an existing database is a no-op and booting
// against an empty one builds the whole schema.

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
 * This used to read PRAGMA table_info and diff the result, because SQLite has
 * no "ADD COLUMN IF NOT EXISTS". Postgres does, so the read is gone and with
 * it the callback that used to wrap these statements — which is why
 * `afterwards` now runs inline rather than inside a nested serialize().
 *
 * @param {string} table
 * @param {Array<[string, string]>} columns  [name, SQL type + constraints]
 * @param {(db: object) => void} [afterwards]  runs once the ALTERs are
 *        queued — for backfills that need the new columns
 */
function addMissingColumns(db, table, columns, afterwards) {
  // The connection runs queued statements strictly in order, so a backfill
  // queued after these ALTERs cannot observe a table without the new columns.
  db.serialize(() => {
    columns.forEach(([name, definition]) => {
      run(db, `${table}.${name}`,
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${definition}`);
    });
    if (afterwards) afterwards(db);
  });
}

/**
 * Widens an existing INTEGER column to BIGINT.
 *
 * CREATE TABLE IF NOT EXISTS cannot change a table that already exists, so a
 * column whose declared width turned out to be too small needs this. Guarded
 * on the current type so it is a no-op once applied — ALTER TYPE rewrites the
 * table, which is not something to do on every boot.
 *
 * Only ever used to widen. Narrowing would lose data and is not offered.
 */
function widenToBigint(db, table, column) {
  db.all(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    [table, column],
    (error, rows) => {
      if (error) {
        console.error(`Schema: reading ${table}.${column} type failed:`, error.message);
        return;
      }
      // No such column yet — the CREATE TABLE that builds it already says
      // BIGINT, so there is nothing to widen.
      if (!rows || rows.length === 0) return;
      if (rows[0].data_type === 'bigint') return;

      run(db, `${table}.${column} -> BIGINT`,
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE BIGINT`);
    }
  );
}

// Default values for the settings table. Existing rows are never overwritten,
// so an admin's edit always survives a restart.
//
// The settings table must already exist when this runs — see the ordering
// note in index.js.
function seedSettings(db, entries) {
  entries.forEach(([key, value]) => {
    run(db, `setting ${key}`, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [key, value]);
  });
}

module.exports = { run, addMissingColumns, seedSettings, widenToBigint };
