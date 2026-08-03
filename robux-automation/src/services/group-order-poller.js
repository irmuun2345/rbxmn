const { attemptGroupDelivery } = require('./group-delivery');

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
// days, not seconds, so this loop keeps re-checking paid orders and delivers
// the moment each one becomes possible — with no further admin involvement.
function startGroupOrderPoller(dbHelpers) {
  // A tick walks every pending order serially, and each order costs several
  // Roblox round trips. Once the queue is long enough that a tick outruns the
  // interval, setInterval would start a second one on top of the first.
  // claimForFulfillment means that can't double-pay, but it does mean piling
  // more concurrent load onto the API that is already the reason we're slow.
  let running = false;

  // Stalled orders are reported once each rather than every 90 seconds
  // forever. The old behaviour buried every other log line under the same
  // warning within a day of a single order getting stuck.
  const reportedStalled = new Set();

  async function tick() {
    if (running) {
      console.warn('Group order poller: previous sweep still running, skipping this tick.');
      return;
    }
    running = true;

    try {
      let orders;
      try {
        orders = await new Promise((resolve, reject) => {
          dbHelpers.getPendingGroupOrders((error, rows) => (error ? reject(error) : resolve(rows)));
        });
      } catch (error) {
        console.error('Group order poller: failed to load pending orders:', error.message);
        return;
      }

      for (const order of orders) {
        try {
          const outcome = await attemptGroupDelivery(dbHelpers, order.id);
          if (outcome.delivered) {
            console.log(`Group order poller: delivered payout for order #${order.id}.`);
            // It can't be stalled any more, so let it be reported again if it
            // somehow returns.
            reportedStalled.delete(order.id);
          }
        } catch (error) {
          // A misconfigured group fails identically for every order in the
          // queue, so it's logged once per sweep rather than once per order.
          if (error.code === 'GROUP_NOT_CONFIGURED') break;
          console.error(
            `Group order poller: order #${order.id} failed:`,
            error.response?.data || error.message
          );
        }
      }

      await reportStalledFulfillments();
    } finally {
      running = false;
    }
  }

  // Orders stuck mid-delivery are never retried here — a payout request that
  // may already have landed must not be sent again, which is the entire
  // reason FULFILLMENT_PROCESSING is excluded from the query above. All this
  // does is make sure a stuck order gets noticed instead of sitting silently.
  async function reportStalledFulfillments() {
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

  // A restart used to mean every paid order waited a full interval before
  // anyone looked at it.
  const firstTick = setTimeout(() => { tick(); }, FIRST_TICK_DELAY_MS);
  firstTick.unref();

  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { startGroupOrderPoller };
