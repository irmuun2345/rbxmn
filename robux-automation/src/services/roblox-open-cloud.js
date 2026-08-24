const axios = require('axios');

// Roblox Open Cloud, which authenticates with an API key rather than the
// bot's session cookie. Kept apart from roblox-group.js for exactly that
// reason: nothing here needs a logged-in account, and nothing here should
// ever be handed one.
const GROUPS_URL = 'https://apis.roblox.com/cloud/v2/groups';

const REQUEST_TIMEOUT_MS = 15000;

// When someone joined the group.
//
// This is the one fact the rest of the payout flow could never establish. The
// classic Groups API reports *that* an account is a member but not *when* it
// became one, so a member who joined before we ever looked at them had their
// clock started from the moment we first noticed — and a customer who had
// genuinely been in the group for a year was told to wait another fourteen
// days.
//
// Open Cloud's membership resource carries `createTime`, which is the real
// join date. Reading it turns the conservative guess into a fact.
//
// Returns null rather than throwing when the answer is unavailable — no API
// key, a key without group:read, a member Roblox does not return, or Open
// Cloud being down. Every caller must be able to carry on without it, because
// the fallback (assume they joined today) is safe: it delays a payout rather
// than issuing one Roblox would reject.
async function fetchGroupJoinDate(groupId, robloxId) {
  const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
  if (!apiKey) return null;

  // Both are interpolated into a URL and a filter expression, so neither is
  // allowed to be anything but digits.
  if (!/^\d+$/.test(String(groupId)) || !/^\d+$/.test(String(robloxId))) return null;

  try {
    const response = await axios.get(
      `${GROUPS_URL}/${groupId}/memberships`,
      {
        headers: { 'x-api-key': apiKey },
        params: {
          maxPageSize: 10,
          filter: `user == 'users/${robloxId}'`
        },
        timeout: REQUEST_TIMEOUT_MS
      }
    );

    const memberships = response.data?.groupMemberships;
    if (!Array.isArray(memberships) || memberships.length === 0) return null;

    const createTime = memberships[0]?.createTime;
    if (!createTime) return null;

    // Roblox returns "0001-01-01T00:00:00Z" for timestamps it does not hold
    // (updateTime does this routinely). A date before Roblox existed is not a
    // join date, and treating one as real would hand someone instant
    // eligibility.
    const parsed = new Date(createTime);
    if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 2006) return null;

    // A join date in the future is equally nonsensical, and would also read
    // as "not yet eligible" forever.
    if (parsed.getTime() > Date.now()) return null;

    return parsed.toISOString();
  } catch (error) {
    // Logged, not thrown. A payout flow must not fail because an optional
    // lookup did — it just falls back to the conservative date.
    console.warn(
      `Open Cloud: could not read join date for user ${robloxId} in group ${groupId}:`,
      error.response?.data?.message || error.message
    );
    return null;
  }
}

module.exports = { fetchGroupJoinDate };
