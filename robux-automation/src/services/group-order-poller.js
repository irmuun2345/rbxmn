const { attemptGroupDelivery } = require('./group-delivery');
const { describeDeliveryFailure } = require('./delivery-errors');

const POLL_INTERVAL_MS = 90 * 1000;

// Give the process a moment to finish opening the database and binding the
// port before the first sweep, but don't make a paid order wait a full
// interval just because the server restarted.
const FIRST_TICK_DELAY_MS = 5 * 1000;

// How long an order may sit mid-delivery before it's reported as stuck. A
// real payout round-trip is seconds; anything still in flight after this
// crashed partway and needs a human to check Roblox.
const STALLED_AFTER_MINUTES = 15;

// Once admin confirms a group order's payment, two things still have to
// happen on Roblox's side: the buyer requests to join, and their membership
// matures past the platform's payout requirement. Both are waits measured in
// days, not seconds, so something has to keep re-checking paid orders and
// deliver the moment each one becomes possible — with no further admin
// involvement.
//
// That "something" is one of two shapes, and this module provides both:
//
//   runGroupOrderSweep()      one sweep, then return. This is what the cron
//                             route calls on Vercel, where nothing survives
//                             between requests and a setInterval would be
//                             killed the moment the response was sent.
//   startGroupOrderPoller()   the long-lived interval, for `npm start` on a
//                             machine that stays up.
//
// Both drive the same sweep, so the two deployments cannot drift apart.

// A sweep walks every pending order serially, and each order costs several
// Roblox round trips. Two overlapping sweeps cannot double-pay — that is what
// claimForFulfillment is for — but they would pile more concurrent load onto
// the API that is already the reason we are slow.
//
// Module scope rather than per-poller so it also guards a cron invocation
// that arrives while a previous one is still working, which is possible
// whenever a sweep outruns the cron interval on a warm instance.
let running = false;

// Stalled orders are reported once each rather than on every sweep forever.
// The old behaviour buried every other log line under the same warning within
// a day of a single order getting stuck.
//
// This is in-process memory, so on Vercel it only dedupes within one warm
// instance and a cold start will re-report. That is the right trade: the
// alternative is a database column whose only purpose is quieting a log line.
const reportedStalled = new Set();

/**
 * One pass over the delivery queue: deliver what can be delivered, then
 * report anything stuck.
 *
 * Never throws — a sweep that fails must not take down the caller, which is
 * either an HTTP request or a timer nobody is watching.
 *
 * @returns {Promise<{skipped?: boolean, considered: number, delivered: number, failed: number}>}
 */
async function runGroupOrderSweep(dbHelpers) {
  if (running) {
    console.warn('Group order poller: previous sweep still running, skipping this tick.');
    return { skipped: true, considered: 0, delivered: 0, failed: 0 };
  }
  running = true;

  let considered = 0;
  let delivered = 0;
  let failed = 0;

  try {
    let orders;
    try {
      orders = await new Promise((resolve, reject) => {
        dbHelpers.getPendingGroupOrders((error, rows) => (error ? reject(error) : resolve(rows)));
      });
    } catch (error) {
      console.error('Group order poller: failed to load pending orders:', error.message);
      return { considered: 0, delivered: 0, failed: 0 };
    }

    considered = orders.length;

    for (const order of orders) {
      try {
        const outcome = await attemptGroupDelivery(dbHelpers, order.id);
        if (outcome.delivered) {
          delivered += 1;
          console.log(`Group order poller: delivered payout for order #${order.id}.`);
          // It can't be stalled any more, so let it be reported again if it
          // somehow returns.
          reportedStalled.delete(order.id);
        }
      } catch (error) {
        failed += 1;
        // A misconfigured group fails identically for every order in the
        // queue, so it's logged once per sweep rather than once per order.
        if (error.code === 'GROUP_NOT_CONFIGURED') break;
        const failure = describeDeliveryFailure(error);
        console.error(
          `Group order poller: order #${order.id} [${failure.action}]: ${failure.message}`
        );
      }
    }

    await reportStalledFulfillments(dbHelpers);
  } finally {
    running = false;
  }

  return { considered, delivered, failed };
}

// Orders stuck mid-delivery are never retried here — a payout request that
// may already have landed must not be sent again, which is the entire reason
// FULFILLMENT_PROCESSING is excluded from the query above. All this does is
// make sure a stuck order gets noticed instead of sitting silently.
async function reportStalledFulfillments(dbHelpers) {
  try {
    const stalled = await new Promise((resolve, reject) => {
      dbHelpers.getStalledFulfillments(STALLED_AFTER_MINUTES, (error, rows) => (
        error ? reject(error) : resolve(rows)
      ));
    });

    const stillStalled = new Set();

    stalled.forEach((order) => {
      stillStalled.add(order.id);
      if (reportedStalled.has(order.id)) return;
      reportedStalled.add(order.id);

      console.warn(
        `Group order poller: order #${order.id} (${order.username}) has been mid-delivery `
        + `since ${order.fulfillment_started_at}. Check the group payout history on Roblox `
        + `and resolve it from the admin queue — it will NOT be retried automatically. `
        + `Last error: ${order.fulfillment_error || 'none recorded'}`
      );
    });

    // Anything an admin has since resolved drops out of the set, so the
    // warning is available again if the order ever stalls a second time.
    reportedStalled.forEach((id) => {
      if (!stillStalled.has(id)) reportedStalled.delete(id);
    });
  } catch (error) {
    console.error('Group order poller: failed to check stalled fulfillments:', error.message);
  }
}

/**
 * The long-lived interval, for a process that stays up. On Vercel nothing
 * does, so the cron route calls runGroupOrderSweep directly instead — see
 * routes/cron.js.
 */
function startGroupOrderPoller(dbHelpers) {
  // A restart used to mean every paid order waited a full interval before
  // anyone looked at it.
  const firstTick = setTimeout(() => { runGroupOrderSweep(dbHelpers); }, FIRST_TICK_DELAY_MS);
  firstTick.unref();

  const timer = setInterval(() => { runGroupOrderSweep(dbHelpers); }, POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { startGroupOrderPoller, runGroupOrderSweep, STALLED_AFTER_MINUTES };
