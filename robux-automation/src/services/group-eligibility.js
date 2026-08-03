const RobloxGroup = require('./roblox-group');

// Roblox will not pay out group funds to an account that has not been in the
// group long enough. The requirement is a platform rule, not a business
// choice, so a payout attempted before it matures fails at Roblox — which is
// why this check has to happen here, before we ever mark an order deliverable.
const DEFAULT_REQUIRED_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getSettingValue(dbHelpers, key) {
  return new Promise((resolve, reject) => {
    dbHelpers.getSetting(key, (error, row) => (error ? reject(error) : resolve(row?.value || '')));
  });
}

async function getRequiredDays(dbHelpers) {
  const configured = Number(await getSettingValue(dbHelpers, 'group_membership_days'));
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_REQUIRED_DAYS;
}

function getMembershipRow(dbHelpers, userId, groupId) {
  return new Promise((resolve, reject) => {
    dbHelpers.getGroupMembership(userId, groupId, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function recordMembership(dbHelpers, userId, robloxId, groupId, joinedAt, source) {
  return new Promise((resolve, reject) => {
    dbHelpers.recordGroupMembership(userId, robloxId, groupId, joinedAt, source, (error, row) => (
      error ? reject(error) : resolve(row)
    ));
  });
}

function daysSince(isoDate) {
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (Date.now() - then) / MS_PER_DAY);
}

// Called the moment we accept someone's join request: this is the only
// occasion on which we know the true join date, so it is recorded as exact.
function recordAcceptedJoin(dbHelpers, userId, robloxId, groupId) {
  return recordMembership(dbHelpers, userId, robloxId, groupId, new Date().toISOString(), 'accepted');
}

// Checks Roblox for current membership and makes sure the local clock exists.
// Someone who joined the group by themselves gets their clock started the
// first time we look — dated from now, not from their real join date, because
// the API doesn't expose it. Erring later is the safe direction: the worst
// case is a buyer waiting longer than they strictly had to, versus a payout
// that Roblox rejects.
async function syncMembership(dbHelpers, user, groupId) {
  const isMember = await RobloxGroup.isGroupMember(groupId, user.roblox_id);
  const existing = await getMembershipRow(dbHelpers, user.id, groupId);

  if (!isMember) {
    // Not a member. Any existing row is stale (they left), and leaving it in
    // place would let someone bank 14 days, leave, rejoin and pay out
    // immediately. Clear it so the clock restarts on their next join.
    if (existing) {
      await new Promise((resolve, reject) => {
        dbHelpers.deleteGroupMembership(user.id, groupId, (error) => (error ? reject(error) : resolve()));
      });
    }
    return { isMember: false, membership: null };
  }

  if (!existing) {
    await recordMembership(dbHelpers, user.id, user.roblox_id, groupId, new Date().toISOString(), 'observed');
    return { isMember: true, membership: await getMembershipRow(dbHelpers, user.id, groupId) };
  }

  await new Promise((resolve, reject) => {
    dbHelpers.touchGroupMembership(user.id, groupId, (error) => (error ? reject(error) : resolve()));
  });
  return { isMember: true, membership: existing };
}

// The single question the rest of the app asks: may this account be paid via
// group payout right now? Returns the supporting numbers too, so the UI can
// say "3 more days" rather than just "no".
async function checkEligibility(dbHelpers, user, groupId, { refresh = true } = {}) {
  const requiredDays = await getRequiredDays(dbHelpers);

  let membership;
  let isMember;
  if (refresh) {
    ({ isMember, membership } = await syncMembership(dbHelpers, user, groupId));
  } else {
    membership = await getMembershipRow(dbHelpers, user.id, groupId);
    isMember = Boolean(membership);
  }

  if (!isMember || !membership) {
    return {
      eligible: false,
      isMember: false,
      reason: 'not_a_member',
      requiredDays,
      daysInGroup: 0,
      daysRemaining: requiredDays,
      joinedAt: null,
      source: null
    };
  }

  const daysInGroup = daysSince(membership.joined_at);
  const eligible = daysInGroup >= requiredDays;

  return {
    eligible,
    isMember: true,
    reason: eligible ? null : 'membership_too_new',
    requiredDays,
    daysInGroup: Math.floor(daysInGroup),
    daysRemaining: eligible ? 0 : Math.ceil(requiredDays - daysInGroup),
    joinedAt: membership.joined_at,
    source: membership.source
  };
}

module.exports = {
  DEFAULT_REQUIRED_DAYS,
  checkEligibility,
  syncMembership,
  recordAcceptedJoin,
  getRequiredDays,
  daysSince
};
