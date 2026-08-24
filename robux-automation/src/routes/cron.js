// The scheduled delivery sweep, exposed as an HTTP route.
//
// On a machine that stays up, the sweep runs on a setInterval inside the
// process (see services/group-order-poller.js). A serverless deployment has
// no such process: the function exists only while it is answering a request,
// and any timer it set is killed with it. So the schedule has to live outside
// the app and call in — Vercel Cron hitting this route on a timetable set in
// vercel.json.
//
// In its own file, next to payments.js, because it is the other route that
// moves value without a browser session behind it.

const crypto = require('crypto');
const { runGroupOrderSweep } = require('../services/group-order-poller');
const { db } = require('../models/db');
const { EXPRESS_SESSION_TABLE } = require('../models/schema/core');

// Logged out by expiry, and never coming back. Failure is logged rather than
// raised: leftover rows are housekeeping, and must not fail a sweep that has
// already delivered orders.
function sweepExpiredSessions() {
  return new Promise((resolve) => {
    db.run(
      `DELETE FROM ${EXPRESS_SESSION_TABLE} WHERE expires_at <= ?`,
      [Date.now()],
      function swept(error) {
        if (error) console.error('Cron: session sweep failed:', error.message);
        else if (this.changes > 0) console.log(`Cron: removed ${this.changes} expired session(s).`);
        resolve();
      }
    );
  });
}

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Without a check,
// this route is an open trigger: anyone who finds the URL could run the
// delivery sweep at will, which is both a Roblox rate-limit problem and a way
// to make the server do unattended payout work on demand.
//
// Compared with timingSafeEqual so the comparison cannot be used as an oracle
// to recover the secret a byte at a time.
function isAuthorisedCron(req) {
  const secret = process.env.CRON_SECRET;

  // Refuse rather than fall open. A deployment that forgot the secret gets a
  // sweep that never runs and says why, not an endpoint the world can call.
  if (!secret) return false;

  const header = req.get('authorization') || '';
  const expected = `Bearer ${secret}`;

  const given = Buffer.from(header);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) return false;
  return crypto.timingSafeEqual(given, wanted);
}

module.exports = function registerCronRoutes(app, controllers, { dbHelpers }) {
  app.get('/api/cron/group-orders', async (req, res) => {
    if (!isAuthorisedCron(req)) {
      if (!process.env.CRON_SECRET) {
        console.error('Cron sweep refused: CRON_SECRET is not set on this deployment.');
      }
      // Deliberately identical whether the secret is missing or wrong — a
      // caller learns only that they are not the scheduler.
      return res.status(401).json({ success: false, error: 'Unauthorized.' });
    }

    try {
      const result = await runGroupOrderSweep(dbHelpers);

      // Expired browser sessions are dropped when they are next read, but a
      // session nobody ever returns to is never read again. The store sweeps
      // them on a timer, which a frozen serverless instance does not run — so
      // the scheduled request that is already here does it instead.
      await sweepExpiredSessions();

      res.json({ success: true, ...result });
    } catch (error) {
      // runGroupOrderSweep is written not to throw, so reaching here means
      // something outside the sweep itself broke.
      console.error('Cron sweep failed:', error);
      res.status(500).json({ success: false, error: 'Sweep failed.' });
    }
  });
};
