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

  // starts_at/ends_at are written with Date#toISOString, so they look like
  // "2026-07-31T03:04:38.087Z" while datetime('now') yields
  // "2026-07-31 04:04:38". BETWEEN on TEXT is a plain string comparison and
  // ' ' (0x20) sorts before 'T' (0x54), so on the event's own start day
  // now >= starts_at was always false: events never activated until the
  // next calendar day, and anything shorter than a day never activated at
  // all. datetime() normalises both sides to the same format.
  getActiveEvent: (callback) => {
    const sql = `SELECT * FROM events
      WHERE datetime('now') BETWEEN datetime(starts_at) AND datetime(ends_at)
      ORDER BY bonus_percent DESC LIMIT 1`;
    db.get(sql, [], callback);
  },

  // Running plus not-yet-started events, for the public Events tab. Past
  // events are dropped — a finished promotion is noise to a buyer.
  getCurrentAndUpcomingEvents: (callback) => {
    const sql = `SELECT * FROM events
      WHERE datetime(ends_at) >= datetime('now')
      ORDER BY datetime(starts_at) ASC`;
    db.all(sql, [], callback);
  },

  deleteEvent: (id, callback) => {
    db.run(`DELETE FROM events WHERE id = ?`, [id], function(err) {
      callback(err, err ? null : { changes: this.changes });
    });
  }
});
