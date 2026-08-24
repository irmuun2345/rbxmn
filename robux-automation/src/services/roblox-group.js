const crypto = require('crypto');
const axios = require('axios');
const { generateTotp } = require('./totp');

const GROUPS_URL = 'https://groups.roblox.com/v1/groups';
const USER_GROUPS_URL = 'https://groups.roblox.com/v2/users';
const AUTH_USER_URL = 'https://users.roblox.com/v1/users/authenticated';
const ECONOMY_URL = 'https://economy.roblox.com/v1/groups';
const TICKET_URL = 'https://auth.roblox.com/v1/authentication-ticket';
const LOGOUT_URL = 'https://auth.roblox.com/v2/logout';
const TWO_STEP_URL = 'https://twostepverification.roblox.com/v1/users';
const CHALLENGE_CONTINUE_URL = 'https://apis.roblox.com/challenge/v1/continue';

// Roblox names the challenge type in a response header. Only one of them can
// be answered without a human in the room.
const TWO_STEP_CHALLENGE = 'twostepverification';

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

  // A 2-step verification demand, read off the response headers Roblox
  // attaches to the 403. Returns null for an ordinary 403.
  static readChallenge(error) {
    const headers = error?.response?.headers || {};
    const id = headers['rblx-challenge-id'];
    const metadata = headers['rblx-challenge-metadata'];
    if (!id || !metadata) return null;

    return {
      id,
      type: String(headers['rblx-challenge-type'] || '').toLowerCase(),
      metadata
    };
  }

  // Answers a 2-step challenge with a code this process generates, and returns
  // the headers that let the refused request through on a second attempt.
  //
  // Every failure in here is flagged `preflight`, and that is a statement
  // about Roblox rather than a convenience: a challenge is raised at the
  // authorisation gate, before the handler behind it runs. The payout that
  // triggered this was refused, not applied. So whatever goes wrong while
  // answering, no Robux moved, and the order is safe to return to the queue.
  static async solveChallenge(challenge, cookie, totpSecret, csrfToken) {
    if (challenge.type !== TWO_STEP_CHALLENGE) {
      throw Object.assign(
        new Error(`Roblox дэмжигдээгүй challenge шаардлаа (${challenge.type || 'тодорхойгүй'}).`),
        { code: 'UNSUPPORTED_CHALLENGE', preflight: true }
      );
    }
    if (!totpSecret) {
      throw Object.assign(
        new Error('Bot аккаунт 2FA код шаардаж байна. Админ хэсэгт authenticator секретийг оруулна уу.'),
        { code: 'TOTP_NOT_CONFIGURED', preflight: true }
      );
    }

    let metadata;
    try {
      metadata = JSON.parse(Buffer.from(challenge.metadata, 'base64').toString('utf8'));
    } catch {
      throw Object.assign(
        new Error('Roblox-ийн challenge мэдээллийг уншиж чадсангүй.'),
        { code: 'CHALLENGE_METADATA_UNREADABLE', preflight: true }
      );
    }

    // The outer `rblx-challenge-id` and the inner `challengeId` are different
    // identifiers for the same demand, and the two endpoints below want
    // different ones. Mixing them up produces a 400 that reads like a bad code.
    const userId = metadata.userId;
    const twoStepChallengeId = metadata.challengeId;
    if (!userId || !twoStepChallengeId) {
      throw Object.assign(
        new Error('Roblox-ийн challenge мэдээлэл дутуу байна.'),
        { code: 'CHALLENGE_METADATA_INCOMPLETE', preflight: true }
      );
    }

    const authHeaders = { ...cookieHeader(cookie), 'X-CSRF-TOKEN': csrfToken };

    try {
      // A code is only valid for its own 30-second window, and a server clock
      // a minute out would otherwise fail every payout forever with an error
      // that says nothing about clocks. One retry against the previous window
      // costs a round trip and covers the realistic drift.
      let verification = null;
      for (const offsetSteps of [0, -1]) {
        try {
          const response = await axios.post(
            `${TWO_STEP_URL}/${encodeURIComponent(userId)}/challenges/authenticator/verify`,
            {
              challengeId: twoStepChallengeId,
              actionType: 'Generic',
              code: generateTotp(totpSecret, { offsetSteps })
            },
            { headers: authHeaders, timeout: REQUEST_TIMEOUT_MS }
          );
          verification = response.data?.verificationToken || null;
          if (verification) break;
        } catch (error) {
          // A rejected code is the only thing worth a second window. Anything
          // else — a malformed secret, a network failure — repeats identically.
          if (offsetSteps !== 0 || error.response?.status !== 400) throw error;
        }
      }

      if (!verification) {
        throw Object.assign(
          new Error('Roblox 2FA кодыг хүлээж авсангүй. Серверийн цаг эсвэл секретийг шалгана уу.'),
          { code: 'TWO_STEP_REJECTED', preflight: true }
        );
      }

      // Roblox wants this object twice over: as a JSON string in the continue
      // body, and base64 of the same JSON in the header on the retry.
      const continuation = JSON.stringify({
        verificationToken: verification,
        challengeId: twoStepChallengeId,
        actionType: 'Generic'
      });

      await axios.post(
        CHALLENGE_CONTINUE_URL,
        {
          challengeId: challenge.id,
          challengeType: TWO_STEP_CHALLENGE,
          challengeMetadata: continuation
        },
        { headers: authHeaders, timeout: REQUEST_TIMEOUT_MS }
      );

      return {
        'rblx-challenge-id': challenge.id,
        'rblx-challenge-type': TWO_STEP_CHALLENGE,
        'rblx-challenge-metadata': Buffer.from(continuation).toString('base64')
      };
    } catch (error) {
      if (error.preflight) throw error;

      // Reached only when the verify or continue call itself failed. The
      // original request was still refused at the gate, so this is every bit
      // as never-sent as the checks above.
      throw Object.assign(
        new Error('Bot-ийн 2FA баталгаажуулалт амжилтгүй боллоо.'),
        { code: 'TWO_STEP_FAILED', preflight: true, cause: error }
      );
    }
  }

  // Wraps a state-changing call so a stale cached token, or a 2FA demand,
  // costs one retry instead of a stranded order.
  //
  // The safety argument for retrying at all: a 403 carrying a fresh
  // x-csrf-token — or a challenge header — means Roblox rejected the request
  // at an authorisation gate, before the handler ran. Nothing was applied, so
  // re-sending cannot double-apply. Any other failure is NOT retried here —
  // see sendPayout.
  //
  // Each of the two conditions is answered at most once, so a request that
  // keeps being refused stops after three attempts instead of looping.
  static async withCsrf(cookie, send, { totpSecret = null } = {}) {
    let token = await this.getCsrfToken(cookie);
    let challengeHeaders = {};
    let csrfRetried = false;
    let challengeSolved = false;

    for (;;) {
      try {
        return await send(token, challengeHeaders);
      } catch (error) {
        if (error.response?.status !== 403) throw error;

        const challenge = this.readChallenge(error);
        if (challenge && !challengeSolved) {
          challengeHeaders = await this.solveChallenge(challenge, cookie, totpSecret, token);
          challengeSolved = true;
          continue;
        }

        const rotated = error.response?.headers?.['x-csrf-token'];
        if (rotated && !csrfRetried) {
          token = rotated;
          csrfCache.set(cookieKey(cookie), { token, fetchedAt: Date.now() });
          csrfRetried = true;
          continue;
        }

        throw error;
      }
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

  // The owner comes back alongside the name because it is the one fact that
  // decides whether a group can be paid out from at all: Roblox lets only the
  // group's owner spend its funds, so a group configured here that the bot
  // does not own can never deliver an order, however healthy it otherwise
  // looks from the outside.
  static async getGroupInfo(groupId) {
    const response = await withRetry(() => axios.get(
      `${GROUPS_URL}/${encodeURIComponent(groupId)}`,
      { timeout: REQUEST_TIMEOUT_MS }
    ));
    const owner = response.data?.owner || null;
    return {
      groupId: String(groupId),
      name: response.data?.name || null,
      ownerId: owner?.userId ? String(owner.userId) : null,
      ownerUsername: owner?.username || null
    };
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
      const status = error.response?.status;
      if (status === 400 || status === 404) return null;

      // 401/403 here does not mean "no request pending" — it is Roblox saying
      // this account may not read the group's join requests. For an account
      // that is supposed to run the group that means one of two things: the
      // cookie is dead, or the configured group is not the bot's to manage.
      // Left as a bare axios error it reaches the admin as an unexplained
      // "try again", so it is named and marked never-sent.
      if (status === 401 || status === 403) {
        throw Object.assign(
          new Error(
            'Bot аккаунт энэ группын нэгдэх хүсэлтийг харах эрхгүй байна. '
            + 'Группын ID бот эзэмшдэг групп мөн эсэх, cookie хүчинтэй эсэхийг шалгана уу.'
          ),
          { code: 'GROUP_PERMISSION_DENIED', preflight: true, status }
        );
      }
      throw error;
    }
  }

  static async acceptJoinRequest(groupId, robloxUserId, cookie, totpSecret = null) {
    return this.withCsrf(cookie, (csrfToken, challengeHeaders) => axios.post(
      `${GROUPS_URL}/${encodeURIComponent(groupId)}/join-requests/users/${encodeURIComponent(robloxUserId)}`,
      {},
      {
        headers: { ...cookieHeader(cookie), 'X-CSRF-TOKEN': csrfToken, ...challengeHeaders },
        timeout: REQUEST_TIMEOUT_MS
      }
    ), { totpSecret });
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
  static async sendPayout(groupId, robloxUserId, amount, cookie, totpSecret = null) {
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

    return this.withCsrf(cookie, (csrfToken, challengeHeaders) => axios.post(
      `${GROUPS_URL}/${encodeURIComponent(groupId)}/payouts`,
      {
        PayoutType: 'FixedAmount',
        Recipients: [{ recipientId, recipientType: 'User', amount: payable }]
      },
      {
        headers: { ...cookieHeader(cookie), 'X-CSRF-TOKEN': csrfToken, ...challengeHeaders },
        timeout: REQUEST_TIMEOUT_MS
      }
    ), { totpSecret });
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
