const RobloxGroup = require('./roblox-group');
const { fetchGroupJoinDate } = require('./roblox-open-cloud');

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
// occasion on which we know the true join date without asking anyone, so it
// is recorded as exact.
function recordAcceptedJoin(dbHelpers, userId, robloxId, groupId) {
  return recordMembership(dbHelpers, userId, robloxId, groupId, new Date().toISOString(), 'accepted');
}

// How the stored joined_at was arrived at, weakest first:
//
//   observed    — a guess. They were already a member when we first looked,
//                 and we dated the clock from that moment.
//   open_cloud  — the real join date, read from Open Cloud.
//   accepted    — we let them in ourselves, so we watched it happen.
//
// Only `observed` is ever overwritten. See correctObservedJoinDate.
const SOURCE = { OBSERVED: 'observed', OPEN_CLOUD: 'open_cloud', ACCEPTED: 'accepted' };

// The true join date if Roblox will tell us, otherwise the conservative one.
//
// Open Cloud knows when a membership was created; the classic API this
// service used to rely on does not. When the lookup works the customer gets
// credit for the time they have actually been in the group — which for
// someone who joined long before they ever ordered is the difference between
// paying out now and making them wait another fourteen days for no reason.
//
// A failed lookup is not an error. It falls back to today, which is the
// behaviour this function replaced, and is safe in the only direction that
// matters: it delays a payout instead of issuing one Roblox would refuse.
async function resolveJoinDate(groupId, robloxId) {
  const actual = await fetchGroupJoinDate(groupId, robloxId);
  return actual
    ? { joinedAt: actual, source: SOURCE.OPEN_CLOUD }
    : { joinedAt: new Date().toISOString(), source: SOURCE.OBSERVED };
}

// Upgrades a previously guessed clock once Roblox can confirm the real date.
//
// Existing customers are the whole point of this: their rows were written
// before the lookup existed, all dated from whenever we happened to notice
// them, and without this they would keep serving out a wait they had already
// served. Running it on every sync means each of them is corrected the next
// time their eligibility is checked — no migration, no admin involvement.
//
// The repository refuses to move anything but an `observed` row, and refuses
// to move it later, so this can only ever help.
async function correctGuessedJoinDate(dbHelpers, membership, groupId, robloxId) {
  if (!membership || membership.source !== SOURCE.OBSERVED) return membership;

  const actual = await fetchGroupJoinDate(groupId, robloxId);
  if (!actual) return membership;

  const corrected = await new Promise((resolve, reject) => {
    dbHelpers.correctObservedJoinDate(
      membership.user_id, groupId, actual, SOURCE.OPEN_CLOUD,
      (error, result) => (error ? reject(error) : resolve(result))
    );
  });

  if (!corrected || corrected.changes === 0) return membership;

  console.log(
    `Group clock corrected for user ${membership.user_id}: `
    + `${membership.joined_at} -> ${actual} (from Open Cloud).`
  );
  return { ...membership, joined_at: actual, source: SOURCE.OPEN_CLOUD };
}

// Checks Roblox for current membership and makes sure the local clock exists.
//
// Someone who joined the group by themselves gets their clock started from
// their real join date, read from Open Cloud. If that lookup is unavailable —
// no API key, or Roblox not answering — it falls back to dating the clock
// from now, which is what this used to do unconditionally. Erring later is
// the safe direction: the worst case is a buyer waiting longer than they
// strictly had to, versus a payout that Roblox rejects and that strands the
// order for an admin.
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
    const { joinedAt, source } = await resolveJoinDate(groupId, user.roblox_id);
    await recordMembership(dbHelpers, user.id, user.roblox_id, groupId, joinedAt, source);
    return { isMember: true, membership: await getMembershipRow(dbHelpers, user.id, groupId) };
  }

  await new Promise((resolve, reject) => {
    dbHelpers.touchGroupMembership(user.id, groupId, (error) => (error ? reject(error) : resolve()));
  });

  // Anyone whose clock was guessed before this lookup existed gets it put
  // right here, on their next eligibility check.
  const membership = await correctGuessedJoinDate(dbHelpers, existing, groupId, user.roblox_id);
  return { isMember: true, membership };
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
  SOURCE,
  checkEligibility,
  syncMembership,
  recordAcceptedJoin,
  resolveJoinDate,
  correctGuessedJoinDate,
  getRequiredDays,
  daysSince
};
