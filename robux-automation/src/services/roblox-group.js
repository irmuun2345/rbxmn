const crypto = require('crypto');
const axios = require('axios');

const GROUPS_URL = 'https://groups.roblox.com/v1/groups';
const USER_GROUPS_URL = 'https://groups.roblox.com/v2/users';
const AUTH_USER_URL = 'https://users.roblox.com/v1/users/authenticated';
const ECONOMY_URL = 'https://economy.roblox.com/v1/groups';
const TICKET_URL = 'https://auth.roblox.com/v1/authentication-ticket';
const LOGOUT_URL = 'https://auth.roblox.com/v2/logout';

// Roblox rotates the CSRF token roughly every few minutes. Refreshing a
// little early is free; being caught with a stale one costs a round trip.
const CSRF_TTL_MS = 4 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15000;

function cookieHeader(cookie) {
  return { Cookie: `.ROBLOSECURITY=${cookie}` };
}

// The cache is keyed by a hash rather than the cookie itself so the bot's
// credential never ends up in a map key that could be dumped in a heap
// snapshot or an error message.
function cookieKey(cookie) {
  return crypto.createHash('sha256').update(String(cookie)).digest('hex');
}

const csrfCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Roblox rate-limits aggressively and drops connections under load. Read-only
// calls are safe to retry; nothing that moves Robux ever goes through here.
async function withRetry(operation, { attempts = 3, baseDelayMs = 400 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      // 4xx other than 429 is a real answer — retrying just repeats it.
      if (status && status !== 429 && status < 500) throw error;
      if (attempt === attempts - 1) break;

      await sleep(baseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}

class RobloxGroup {
  // Roblox's classic APIs require a CSRF token on any state-changing request,
  // and the way to obtain one is to make a request without it and read the
  // token out of the 403 response header.
  //
  // Which endpoint you pick for that matters more than it looks. This used to
  // POST to /v2/logout, which returns the token *because it refuses* — but if
  // that call ever succeeded it would invalidate the bot's .ROBLOSECURITY
  // cookie and halt every delivery until someone re-entered it by hand. The
  // whole mechanism depended on a request failing.
  //
  // /v1/authentication-ticket answers with the same 403-plus-token, and its
  // success case is harmless: it mints a short-lived ticket nobody reads.
  // Logout remains as a fallback only because it is known to work against the
  // live API, and its success case is now treated as the emergency it is.
  static async fetchCsrfToken(cookie) {
    const attempt = async (url) => {
      try {
        const response = await axios.post(url, null, {
          headers: cookieHeader(cookie),
          timeout: REQUEST_TIMEOUT_MS
        });
        // A 2xx means no token was ever handed back. For logout that also
        // means the bot is now signed out, so say so loudly — the symptom
        // otherwise is every delivery failing at once with no explanation.
        if (url === LOGOUT_URL) {
          console.error(
            'CRITICAL: Roblox accepted the logout used for CSRF acquisition. '
            + 'The bot cookie is now invalid and must be replaced in the admin dashboard.'
          );
          csrfCache.delete(cookieKey(cookie));
        }
        return response.headers?.['x-csrf-token'] || null;
      } catch (error) {
        return error.response?.headers?.['x-csrf-token'] || null;
      }
    };

    const token = (await attempt(TICKET_URL)) || (await attempt(LOGOUT_URL));
    if (token) return token;

    // Marked so callers can tell "we never got as far as the real request"
    // apart from "the real request failed" — see sendPayout.
    throw Object.assign(
      new Error('Roblox CSRF token авах хүсэлт хүлээгдээгүй хариу буцаалаа.'),
      { csrfFailure: true }
    );
  }

  static async getCsrfToken(cookie, { forceRefresh = false } = {}) {
    const key = cookieKey(cookie);
    const cached = csrfCache.get(key);

    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CSRF_TTL_MS) {
      return cached.token;
    }

    const token = await this.fetchCsrfToken(cookie);
    csrfCache.set(key, { token, fetchedAt: Date.now() });
    return token;
  }

  // Wraps a state-changing call so a stale cached token costs one retry
  // instead of a stranded order.
  //
  // The safety argument for retrying at all: a 403 carrying a fresh
  // x-csrf-token means Roblox rejected the request at the CSRF gate, before
  // the handler ran. Nothing was applied, so re-sending cannot double-apply.
  // Any other failure is NOT retried here — see sendPayout.
  static async withCsrf(cookie, send) {
    let token = await this.getCsrfToken(cookie);

    try {
      return await send(token);
    } catch (error) {
      const rotated = error.response?.status === 403 && error.response?.headers?.['x-csrf-token'];
      if (!rotated) throw error;

      token = error.response.headers['x-csrf-token'];
      csrfCache.set(cookieKey(cookie), { token, fetchedAt: Date.now() });
      return send(token);
    }
  }

  static async getAuthenticatedBotUser(cookie) {
    const response = await withRetry(() => axios.get(AUTH_USER_URL, {
      headers: cookieHeader(cookie),
      timeout: REQUEST_TIMEOUT_MS
    }));
    if (!response.data?.id || !response.data?.name) {
      throw new Error('Roblox bot аккаунтын мэдээлэл олдсонгүй. Cookie шалгана уу.');
    }
    return { robloxId: String(response.data.id), username: response.data.name };
  }

  static async getGroupInfo(groupId) {
    const response = await withRetry(() => axios.get(
      `${GROUPS_URL}/${encodeURIComponent(groupId)}`,
      { timeout: REQUEST_TIMEOUT_MS }
    ));
    return { groupId: String(groupId), name: response.data?.name || null };
  }

  // The group's spendable Robux. Checked before a payout so "the group is
  // empty" is discovered *before* anything is sent — which keeps the order
  // safely retryable instead of stranding it in FULFILLMENT_PROCESSING.
  static async getGroupFunds(groupId, cookie) {
    const response = await withRetry(() => axios.get(
      `${ECONOMY_URL}/${encodeURIComponent(groupId)}/currency`,
      { headers: cookieHeader(cookie), timeout: REQUEST_TIMEOUT_MS }
    ));
    const robux = Number(response.data?.robux);
    return Number.isFinite(robux) ? robux : null;
  }

  // Public, cookie-free membership check — catches buyers who already joined
  // (this order or an earlier one) so we don't wait forever on a join
  // request that will never appear.
  static async isGroupMember(groupId, robloxUserId) {
    const response = await withRetry(() => axios.get(
      `${USER_GROUPS_URL}/${encodeURIComponent(robloxUserId)}/groups/roles`,
      { timeout: REQUEST_TIMEOUT_MS }
    ));
    const memberships = response.data?.data || [];
    return memberships.some((entry) => String(entry.group?.id) === String(groupId));
  }

  static async getJoinRequest(groupId, robloxUserId, cookie) {
    try {
      const response = await withRetry(() => axios.get(
        `${GROUPS_URL}/${encodeURIComponent(groupId)}/join-requests/users/${encodeURIComponent(robloxUserId)}`,
        { headers: cookieHeader(cookie), timeout: REQUEST_TIMEOUT_MS }
      ));
      return response.data || null;
    } catch (error) {
      if (error.response?.status === 400 || error.response?.status === 404) return null;
      throw error;
    }
  }

  static async acceptJoinRequest(groupId, robloxUserId, cookie) {
    return this.withCsrf(cookie, (csrfToken) => axios.post(
      `${GROUPS_URL}/${encodeURIComponent(groupId)}/join-requests/users/${encodeURIComponent(robloxUserId)}`,
      {},
      {
        headers: { ...cookieHeader(cookie), 'X-CSRF-TOKEN': csrfToken },
        timeout: REQUEST_TIMEOUT_MS
      }
    ));
  }

  // Every payout this system sends passes through here, so the argument check
  // is not paranoia: `delivered_robux || price` upstream would quietly become
  // NaN if both were ever null, and Roblox's own validation is not something
  // to find out about after the fact.
  static assertPayableAmount(amount) {
    const value = Number(amount);
    if (!Number.isInteger(value) || value < 1) {
      throw Object.assign(
        new Error(`Payout дүн буруу байна (${amount}).`),
        { code: 'INVALID_PAYOUT_AMOUNT', preflight: true }
      );
    }
    // A single order in this storefront is a Robux package, not a fortune. A
    // value above this means a pricing or migration bug upstream, and the
    // right response is to refuse rather than to wire it to Roblox.
    if (value > 1000000) {
      throw Object.assign(
        new Error(`Payout дүн хэтэрхий их байна (${value}).`),
        { code: 'PAYOUT_AMOUNT_TOO_LARGE', preflight: true }
      );
    }
    return value;
  }

  // Sends group funds. Errors carry two flags the caller depends on:
  //
  //   preflight: true  — we never sent the payout body. No Robux moved, so
  //                      the order is safe to return to the queue.
  //   csrfFailure      — same guarantee, raised while acquiring the token.
  //
  // Anything else is ambiguous by construction: once the request is on the
  // wire, a timeout or a 5xx cannot tell us whether Roblox applied it. Those
  // errors deliberately carry neither flag, and the caller strands the order
  // for a human rather than risk paying twice.
  static async sendPayout(groupId, robloxUserId, amount, cookie) {
    const payable = this.assertPayableAmount(amount);

    const recipientId = Number(robloxUserId);
    if (!Number.isInteger(recipientId) || recipientId < 1) {
      throw Object.assign(
        new Error(`Хүлээн авагчийн Roblox ID буруу байна (${robloxUserId}).`),
        { code: 'INVALID_RECIPIENT', preflight: true }
      );
    }

    // Preflight: refuse rather than send a payout the group cannot cover.
    // A funds lookup that itself fails is not treated as fatal — it is a
    // convenience, and Roblox remains the authority on whether it can pay.
    let funds = null;
    try {
      funds = await this.getGroupFunds(groupId, cookie);
    } catch (error) {
      console.warn(`Could not read group ${groupId} balance before payout:`, error.message);
    }

    if (funds !== null && funds < payable) {
      throw Object.assign(
        new Error(`Группын үлдэгдэл хүрэлцэхгүй байна (${funds} R$ / ${payable} R$ шаардлагатай).`),
        { code: 'INSUFFICIENT_GROUP_FUNDS', preflight: true, available: funds, required: payable }
      );
    }

    return this.withCsrf(cookie, (csrfToken) => axios.post(
      `${GROUPS_URL}/${encodeURIComponent(groupId)}/payouts`,
      {
        PayoutType: 'FixedAmount',
        Recipients: [{ recipientId, recipientType: 'User', amount: payable }]
      },
      {
        headers: { ...cookieHeader(cookie), 'X-CSRF-TOKEN': csrfToken },
        timeout: REQUEST_TIMEOUT_MS
      }
    ));
  }

  // The group's recent payout ledger, straight from Roblox.
  //
  // This is what turns "go and check the group's payout history yourself"
  // into something the dashboard can answer. Fetched once and matched against
  // many orders, because an admin looking at a stalled queue wants one API
  // call, not one per row.
  //
  // Returns null — never [] — when the ledger could not be read. The
  // difference matters enormously downstream: [] means "Roblox says no payout
  // happened", null means "we don't know", and only the first is safe to act
  // on.
  static async getRecentPayouts(groupId, cookie) {
    try {
      const response = await withRetry(() => axios.get(
        `${ECONOMY_URL}/${encodeURIComponent(groupId)}/transactions`,
        {
          headers: cookieHeader(cookie),
          params: { transactionType: 'GroupPayout', limit: 100, sortOrder: 'Desc' },
          timeout: REQUEST_TIMEOUT_MS
        }
      ));

      const entries = response.data?.data;
      return Array.isArray(entries) ? entries : null;
    } catch (error) {
      console.warn(`Could not read payout history for group ${groupId}:`, error.message);
      return null;
    }
  }

  // Pure matcher over a ledger from getRecentPayouts. Kept separate from the
  // fetch so it can be reasoned about — and tested — without a network call.
  //
  // Roblox's transaction shape has drifted between API versions, hence the
  // fallbacks on every field. A payout we can't parse is reported as "not
  // found" rather than guessed at, which fails towards asking a human.
  static matchPayout(entries, robloxUserId, amount, { sinceMs = 24 * 60 * 60 * 1000 } = {}) {
    if (!Array.isArray(entries)) return null;

    const cutoff = Date.now() - sinceMs;
    const target = Number(amount);

    return entries.some((entry) => {
      const recipient = entry.agent?.id ?? entry.recipient?.id ?? entry.targetId;
      if (String(recipient) !== String(robloxUserId)) return false;

      // Roblox reports a payout as negative from the group's side, so compare
      // magnitudes rather than signs.
      const paid = Math.abs(Number(entry.currency?.amount ?? entry.amount));
      if (paid !== target) return false;

      const at = new Date(entry.created ?? entry.date ?? 0).getTime();
      return Number.isNaN(at) ? false : at >= cutoff;
    });
  }
}

module.exports = RobloxGroup;
