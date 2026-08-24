const assert = require('assert');

const createEventRepository = require('../src/models/repositories/events');
const { temporaryDatabase, run, discard } = require('./helpers/temporary-database');

// Regression cover for the active-event window.
//
// Under SQLite, starts_at/ends_at were TEXT written by Date#toISOString, so
// they carried a 'T' separator and a trailing 'Z' while datetime('now')
// yielded "YYYY-MM-DD HH:MM:SS". BETWEEN on a TEXT column is a plain string
// comparison, and ' ' (0x20) sorts before 'T' (0x54) — so on an event's own
// start day `now >= starts_at` was false. Events silently lost their first
// day, and anything shorter than a day never activated at all. That was not
// cosmetic: the same query decides the bonus applied to a paid order, so a
// promised bonus was quietly dropped.
//
// The columns are TIMESTAMPTZ now and the comparison is between real
// instants, which is what makes the bug structurally impossible rather than
// merely fixed. These cases stay because the *window* logic — which event
// wins, and when — is worth pinning down regardless of column type.
//
// The query under test is the real one: this drives the events repository
// rather than a copy of its SQL, so the test cannot pass against a query the
// application no longer runs.

const TABLE = `CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  bonus_percent REAL NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL
)`;

async function withRepository(body) {
  const db = temporaryDatabase();
  try {
    await run(db, TABLE);
    const repository = createEventRepository(db);

    const insert = (name, bonus, startsAt, endsAt) => new Promise((resolve, reject) => {
      repository.createEvent(name, bonus, startsAt.toISOString(), endsAt.toISOString(),
        (error) => (error ? reject(error) : resolve()));
    });

    const activeEvent = () => new Promise((resolve, reject) => {
      repository.getActiveEvent((error, row) => (error ? reject(error) : resolve(row)));
    });

    await body({ insert, activeEvent });
  } finally {
    await discard(db);
  }
}

const at = (offsetMs) => new Date(Date.now() + offsetMs);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

async function testEventWindow() {
  await withRepository(async ({ insert, activeEvent }) => {
    // Started an hour ago, ends in an hour: the exact same-day case the old
    // string comparison got wrong.
    await insert('Running now', 10, at(-HOUR), at(HOUR));
    const running = await activeEvent();
    assert.ok(running, 'an event running right now must be active');
    assert.equal(running.name, 'Running now');

    // A two-hour promotion begins and ends within one calendar day, so the
    // old comparison could never have matched it at all.
    await insert('Short burst', 25, at(-30 * 60_000), at(90 * 60_000));
    const strongest = await activeEvent();
    assert.equal(strongest.name, 'Short burst', 'highest bonus among live events wins');
  });

  await withRepository(async ({ insert, activeEvent }) => {
    await insert('Already finished', 50, at(-2 * DAY), at(-DAY));
    await insert('Not started yet', 50, at(DAY), at(2 * DAY));
    assert.equal(await activeEvent(), undefined, 'past and future events are not active');
  });
}

testEventWindow()
  .then(() => console.log('Event window activation test passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
