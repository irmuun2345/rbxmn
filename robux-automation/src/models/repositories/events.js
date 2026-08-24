// Time-boxed bonus windows.
module.exports = (db) => ({
  createEvent: (name, bonusPercent, startsAt, endsAt, callback) => {
    const sql = `INSERT INTO events (name, bonus_percent, starts_at, ends_at) VALUES (?, ?, ?, ?)`;
    db.run(sql, [name, bonusPercent, startsAt, endsAt], function(err) {
      callback(err, err ? null : { id: this.lastID, name, bonusPercent, startsAt, endsAt });
    });
  },

  getEvents: (callback) => {
    db.all(`SELECT * FROM events ORDER BY starts_at DESC`, [], callback);
  },

  // starts_at/ends_at are TIMESTAMPTZ columns, so these are real instant
  // comparisons and both sides are in UTC.
  //
  // Under SQLite they were TEXT, written by Date#toISOString as
  // "2026-07-31T03:04:38.087Z" and compared against datetime('now')'s
  // "2026-07-31 04:04:38" — a byte-wise string comparison in which ' '
  // (0x20) sorts before 'T' (0x54). On an event's own start day
  // now >= starts_at was therefore always false: events never activated
  // until the next calendar day, and anything shorter than a day never
  // activated at all. The datetime() wrappers that used to normalise both
  // sides are gone because the column type now does it.
  getActiveEvent: (callback) => {
    const sql = `SELECT * FROM events
      WHERE NOW() BETWEEN starts_at AND ends_at
      ORDER BY bonus_percent DESC LIMIT 1`;
    db.get(sql, [], callback);
  },

  // Running plus not-yet-started events, for the public Events tab. Past
  // events are dropped — a finished promotion is noise to a buyer.
  getCurrentAndUpcomingEvents: (callback) => {
    const sql = `SELECT * FROM events
      WHERE ends_at >= NOW()
      ORDER BY starts_at ASC`;
    db.all(sql, [], callback);
  },

  deleteEvent: (id, callback) => {
    db.run(`DELETE FROM events WHERE id = ?`, [id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  }
});
