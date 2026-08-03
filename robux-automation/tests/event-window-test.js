const assert = require('assert');
const sqlite3 = require('sqlite3');

// Regression cover for the active-event window.
//
// starts_at/ends_at are written with Date#toISOString, so they carry a 'T'
// separator and a trailing 'Z'. datetime('now') yields "YYYY-MM-DD HH:MM:SS".
// BETWEEN on a TEXT column is a plain string comparison, and ' ' (0x20) sorts
// before 'T' (0x54) — so on an event's own start day `now >= starts_at` was
// false. Events silently lost their first day, and anything shorter than a
// day never activated at all. That is not cosmetic: the same query decides
// the bonus applied to a paid order, so a promised bonus was quietly dropped.
//
// The query under test is the one in src/models/db.js getActiveEvent.
const ACTIVE_EVENT_SQL = `SELECT * FROM events
  WHERE datetime('now') BETWEEN datetime(starts_at) AND datetime(ends_at)
  ORDER BY bonus_percent DESC LIMIT 1`;

function withDb(run) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:');
    db.serialize(() => {
      db.run(`CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        bonus_percent REAL NOT NULL,
        starts_at DATETIME NOT NULL,
        ends_at DATETIME NOT NULL
      )`, (error) => (error ? reject(error) : run(db, resolve, reject)));
    });
  });
}

const insert = (db, name, bonus, startsAt, endsAt) => new Promise((resolve, reject) => {
  db.run(
    'INSERT INTO events (name, bonus_percent, starts_at, ends_at) VALUES (?,?,?,?)',
    [name, bonus, startsAt.toISOString(), endsAt.toISOString()],
    (error) => (error ? reject(error) : resolve())
  );
});

const activeEvent = (db) => new Promise((resolve, reject) => {
  db.get(ACTIVE_EVENT_SQL, [], (error, row) => (error ? reject(error) : resolve(row)));
});

const at = (offsetMs) => new Date(Date.now() + offsetMs);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

async function testEventWindow() {
  await withDb(async (db, done, fail) => {
    try {
      // Started an hour ago, ends in an hour: the exact same-day case the old
      // string comparison got wrong.
      await insert(db, 'Running now', 10, at(-HOUR), at(HOUR));
      const running = await activeEvent(db);
      assert.ok(running, 'an event running right now must be active');
      assert.equal(running.name, 'Running now');

      // A two-hour promotion begins and ends within one calendar day, so the
      // old comparison could never have matched it at all.
      await insert(db, 'Short burst', 25, at(-30 * 60_000), at(90 * 60_000));
      const strongest = await activeEvent(db);
      assert.equal(strongest.name, 'Short burst', 'highest bonus among live events wins');

      done();
    } catch (error) {
      fail(error);
    }
  });

  await withDb(async (db, done, fail) => {
    try {
      await insert(db, 'Already finished', 50, at(-2 * DAY), at(-DAY));
      await insert(db, 'Not started yet', 50, at(DAY), at(2 * DAY));
      assert.equal(await activeEvent(db), undefined, 'past and future events are not active');
      done();
    } catch (error) {
      fail(error);
    }
  });
}

testEventWindow()
  .then(() => console.log('Event window activation test passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
