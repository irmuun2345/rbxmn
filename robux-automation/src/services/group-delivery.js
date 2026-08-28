const RobloxGroup = require('./roblox-group');
const { ORDER_STATUS } = require('./order-status');
const orders = require('./orders');
const { checkEligibility, recordAcceptedJoin } = require('./group-eligibility');
const { ACTIONS, recordSystemAction } = require('./audit');

function getSettingValue(dbHelpers, key) {
  return new Promise((resolve, reject) => {
    dbHelpers.getSetting(key, (error, row) => {
      if (error) reject(error);
      else resolve(row?.value || '');
    });
  });
}

// Admits anyone with a pending join request and starts their membership
// clock. Kept separate from the payout because the two can be many days
// apart: a buyer joining today cannot be paid out today, so admission has to
// happen as early as possible and independently of any delivery attempt.
// Never throws for the ordinary "no request pending" case.
//
// Admission is a convenience, not a precondition of getting paid. A group
// whose join requests are approved by a human — or one anybody can walk into
// — never needs the bot to hold member-management rights at all, and letting
// a refusal here abort the run would strand the payout of a buyer who is
// already a member and waiting on nothing. So the permission refusal is
// reported and stepped over; the eligibility check that follows is what
// actually decides whether this buyer can be paid.
//
// Only the permission refusal is swallowed. Anything else — a dead cookie, a
// network failure, Roblox returning something unexpected — still throws,
// because those say nothing about admission and everything about whether the
// payout that follows can be trusted.
//
// Deliberately not written to the audit log: the poller reaches this branch
// for every pending order every 90 seconds, and a table full of "could not
// check join requests" would bury the entries worth reading.
async function admitPendingJoinRequest(dbHelpers, order, groupId, cookie, totpSecret = null) {
  let joinRequest;
  try {
    joinRequest = await RobloxGroup.getJoinRequest(groupId, order.roblox_id, cookie);
  } catch (error) {
    if (error.code !== 'GROUP_PERMISSION_DENIED') throw error;
    console.warn(
      `Order ${order.id}: skipping join-request admission — the bot may not read `
      + `group ${groupId}'s join requests (HTTP ${error.status}). Continuing to eligibility.`
    );
    return false;
  }
  if (!joinRequest) return false;

  try {
    await RobloxGroup.acceptJoinRequest(groupId, order.roblox_id, cookie, totpSecret);
  } catch (error) {
    // Reading the request was allowed but accepting it was not. Same
    // reasoning as above, and the buyer stays queued until somebody admits
    // them by hand.
    if (error.code !== 'GROUP_PERMISSION_DENIED' && error.status !== 401 && error.status !== 403) {
      throw error;
    }
    console.warn(
      `Order ${order.id}: join request found but the bot may not accept it in `
      + `group ${groupId}. Admit the buyer manually.`
    );
    return false;
  }

  await recordAcceptedJoin(dbHelpers, order.user_id, order.roblox_id, groupId);

  // The join timestamp is the start of the payout clock, so the moment it's
  // set needs to be reconstructable independently of the membership row.
  await recordSystemAction(dbHelpers, ACTIONS.GROUP_JOIN_ACCEPTED, {
    entityType: 'user',
    entityId: order.user_id,
    details: { groupId, robloxId: order.roblox_id, orderId: order.id }
  });
  return true;
}

// Shared by the admin "check now" button and the background poller. Walks an
// order as far towards delivery as it can get today and reports where it
// stopped; the poller simply calls it again tomorrow. Returns
// delivered:false (rather than throwing) for every ordinary "not yet" case.
async function attemptGroupDelivery(dbHelpers, orderId) {
  const order = await new Promise((resolve, reject) => {
    dbHelpers.getOrderWithUser(orderId, (error, row) => (error ? reject(error) : resolve(row)));
  });

  if (!order) throw Object.assign(new Error('Захиалга олдсонгүй.'), { code: 'ORDER_NOT_FOUND' });
  if (order.delivery_method !== 'group') {
    throw Object.assign(new Error('Энэ захиалга групп аргаар үүсээгүй байна.'), { code: 'WRONG_METHOD' });
  }
  if (order.status !== ORDER_STATUS.FULFILLMENT_PENDING) {
    throw Object.assign(new Error('Захиалга авахад бэлэн төлөвт биш байна.'), { code: 'WRONG_STATUS' });
  }

  const [groupId, bot] = await Promise.all([
    getSettingValue(dbHelpers, 'group_id'),
    new Promise((resolve, reject) => {
      dbHelpers.getActiveSellerBot((error, row) => (error ? reject(error) : resolve(row)));
    })
  ]);

  if (!groupId || !bot?.cookie) {
    const error = new Error('Групп ID эсвэл bot аккаунт тохируулагдаагүй байна.');
    error.code = 'GROUP_NOT_CONFIGURED';
    throw error;
  }

  // Step 1 — let them in if they're waiting at the door. This starts the
  // membership clock and is worth doing even though it can't possibly make
  // today's payout succeed.
  await admitPendingJoinRequest(dbHelpers, order, groupId, bot.cookie, bot.totp_secret);

  // Step 2 — has the clock run long enough? checkEligibility also syncs the
  // local record against Roblox, so a member admitted just now is picked up
  // here with a fresh joined_at rather than being missed entirely.
  const eligibility = await checkEligibility(
    dbHelpers,
    { id: order.user_id, roblox_id: order.roblox_id },
    groupId
  );

  if (!eligibility.isMember) {
    return { delivered: false, reason: 'awaiting_join', eligibility };
  }
  if (!eligibility.eligible) {
    // A member, but not for long enough. Roblox would refuse the payout, so
    // the order simply waits — the poller will pick it up once the clock
    // matures, with no admin involvement needed.
    //
    // Not logged: the poller re-reaches this branch every 90 seconds for
    // days, and an audit trail drowned in "still waiting" is a useless one.
    return { delivered: false, reason: 'membership_too_new', eligibility };
  }

  // Step 3 — take the delivery lock. Every check above is read-only, so
  // nothing before this point can have moved Robux. Losing the race means
  // another caller (the poller, a second admin click) is already handling
  // this order and we must not issue a payout of our own.
  const claimed = await orders.claimForFulfillment(dbHelpers, orderId);
  if (!claimed) {
    return { delivered: false, reason: 'already_processing' };
  }

  // delivered_robux carries any event/referral bonus; price is the base
  // package. Resolved once here so the amount actually sent, the amount
  // logged on failure and the amount logged on success can never disagree.
  const payoutRobux = order.delivered_robux || order.price;

  try {
    await RobloxGroup.sendPayout(groupId, order.roblox_id, payoutRobux, bot.cookie, bot.totp_secret);
  } catch (error) {
    const detail = JSON.stringify(error.response?.data || error.message);

    // Two kinds of failure, and the difference decides whether a human has to
    // get involved:
    //
    //   csrfFailure — died while acquiring the token
    //   preflight   — refused locally (bad amount, bad recipient, group broke)
    //
    // Both guarantee the payout body never reached Roblox, so the order goes
    // straight back in the queue. Everything else is ambiguous once the
    // request is on the wire, and gets stranded for an admin instead.
    const neverSent = Boolean(error.csrfFailure || error.preflight);

    if (neverSent) {
      await orders.releaseFulfillmentClaim(dbHelpers, orderId, detail);
    } else {
      // The payout request may have landed. Leave the order locked in
      // FULFILLMENT_PROCESSING — the poller skips it and an admin resolves
      // it by hand after checking the group's payout history. Retrying here
      // is exactly how a buyer gets paid twice.
      await orders.recordFulfillmentError(dbHelpers, orderId, detail);
    }

    await recordSystemAction(dbHelpers, ACTIONS.ORDER_FULFILLMENT_FAILED, {
      entityType: 'order',
      entityId: orderId,
      details: {
        route: 'group',
        amount: payoutRobux,
        // The field an admin needs first when resolving this by hand.
        payoutMayHaveLanded: !neverSent,
        requeued: neverSent,
        reason: error.code || null,
        error: detail.slice(0, 500)
      }
    });

    // The one distinction the admin-facing message cannot get wrong: an
    // ambiguous failure must never be described as "try again". Only this
    // scope knows which kind it was, so it is recorded on the error itself.
    error.payoutAttempted = true;
    error.payoutMayHaveLanded = !neverSent;
    throw error;
  }

  await orders.markCompleted(dbHelpers, orderId);

  await recordSystemAction(dbHelpers, ACTIONS.ORDER_FULFILLED, {
    entityType: 'order',
    entityId: orderId,
    details: {
      route: 'group',
      groupId,
      robloxId: order.roblox_id,
      deliveredRobux: payoutRobux,
      daysInGroup: eligibility.daysInGroup
    }
  });

  return { delivered: true, eligibility };
}

module.exports = { attemptGroupDelivery, admitPendingJoinRequest };
