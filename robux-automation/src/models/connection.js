const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// The single connection every repository shares.
//
// Kept in its own module so that requiring the connection does not drag in
// the schema or all 95 helpers — and so there is exactly one place that
// decides where the database file lives.
//
// DATABASE_PATH overrides that location. It exists so a test run, or a second
// instance, can be pointed at a scratch file instead of the live one; leave it
// unset in production and the default below applies.
const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'robux.db');

console.log('Opening SQLite database...');

const db = new sqlite3.Database(DB_PATH, (error) => {
  if (error) {
    console.error('Error opening database:', error.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

module.exports = { db, DB_PATH };
