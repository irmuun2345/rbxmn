const assert = require('assert');
const bcrypt = require('bcrypt');
const axios = require('axios');
const RobloxAuth = require('../src/services/roblox-auth');
const AuthController = require('../src/controllers/auth-controller');
const GamePassController = require('../src/controllers/gamepass-controller');
const AdminController = require('../src/controllers/admin-controller');
const { ORDER_STATUS } = require('../src/services/order-status');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

// Stands in for express-session's req.session. regenerate() has to actually
// empty the object, because the controller relies on that when it rotates the
// session id at login — a mock that kept the old keys would let a broken
// implementation pass.
function createSessionMock() {
  const session = {
    regenerate(callback) {
      Object.keys(this).forEach((key) => {
        if (typeof this[key] !== 'function') delete this[key];
      });
      callback(null);
    },
    save(callback) {
      callback(null);
    },
    destroy(callback) {
      callback(null);
    }
  };
  return session;
}

async function testAuthorizationUrl() {
  const original = {
    clientId: process.env.ROBLOX_OAUTH_CLIENT_ID,
    clientSecret: process.env.ROBLOX_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.ROBLOX_OAUTH_REDIRECT_URI
  };

  process.env.ROBLOX_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.ROBLOX_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.ROBLOX_OAUTH_REDIRECT_URI = 'http://localhost:3000/auth/roblox/callback';

  try {
    const request = await RobloxAuth.createOAuthRequest({
      state: 'test-session.test-state',
      redirectUri: process.env.ROBLOX_OAUTH_REDIRECT_URI
    });
    const url = new URL(request.authorizationUrl);

    assert.equal(url.origin, 'https://apis.roblox.com');
    assert.equal(url.pathname, '/oauth/v1/authorize');
    assert.equal(url.searchParams.get('client_id'), 'test-client-id');
    assert.equal(url.searchParams.get('redirect_uri'), process.env.ROBLOX_OAUTH_REDIRECT_URI);
    assert.equal(url.searchParams.get('scope'), 'openid profile game-pass:write');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'test-session.test-state');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(request.codeVerifier.length >= 43);
    assert.ok(request.qrCode.startsWith('data:image/png;base64,'));
    assert.ok(!request.authorizationUrl.includes('test-client-secret'));
  } finally {
    for (const [key, value] of Object.entries({
      ROBLOX_OAUTH_CLIENT_ID: original.clientId,
      ROBLOX_OAUTH_CLIENT_SECRET: original.clientSecret,
      ROBLOX_OAUTH_REDIRECT_URI: original.redirectUri
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testVerifiedCallbackFlow() {
  const sessions = new Map();
  const users = new Map();
  let tokenExchanges = 0;
  const dbHelpers = {
    createSession(id, userId, sessionData, expiresAt, callback) {
      sessions.set(id, {
        id,
        user_id: userId,
        session_data: sessionData,
        expires_at: Number(expiresAt)
      });
      callback(null, { id });
    },
    getSessionById(id, callback) {
      const session = sessions.get(id);
      callback(null, session && session.expires_at > Date.now() ? session : null);
    },
    getUserByRobloxId(robloxId, callback) {
      callback(null, users.get(String(robloxId)) || null);
    },
    createUser(username, robloxId, callback) {
      const user = { id: users.size + 1, username, roblox_id: robloxId };
      users.set(String(robloxId), user);
      callback(null, user);
    }
  };
  const oauth = {
    async createOAuthRequest({ state, redirectUri }) {
      return {
        authorizationUrl: `https://apis.roblox.com/oauth/v1/authorize?state=${encodeURIComponent(state)}`,
        codeVerifier: 'v'.repeat(64),
        redirectUri,
        qrCode: 'data:image/png;base64,test'
      };
    },
    async exchangeAuthorizationCode() {
      tokenExchanges += 1;
      return {
        robloxId: '1516563360',
        username: 'verified_user',
        displayName: 'Verified User',
        picture: null,
        accessToken: 'short-lived-token',
        accessTokenExpiresAt: Date.now() + 15 * 60 * 1000,
        authorizedUniverseIds: ['3828411582']
      };
    }
  };
  const controller = new AuthController(dbHelpers, oauth);
  const generateResponse = createResponse();

  await controller.generateQRCode({
    protocol: 'http',
    get: () => 'localhost:3000'
  }, generateResponse);

  assert.equal(generateResponse.statusCode, 200);
  assert.equal(generateResponse.body.success, true);
  const sessionId = generateResponse.body.sessionId;
  const pendingSession = JSON.parse(sessions.get(sessionId).session_data);

  const pendingResponse = createResponse();
  const pendingRequest = { params: { sessionId }, session: createSessionMock() };
  await controller.checkAuthStatus(pendingRequest, pendingResponse);
  assert.equal(pendingResponse.body.status, 'pending');
  assert.equal(pendingRequest.session.userId, undefined);
  assert.equal(tokenExchanges, 0);

  const badCallbackResponse = createResponse();
  await controller.handleOAuthCallback({
    query: { state: `${sessionId}.wrong`, code: 'unused' }
  }, badCallbackResponse);
  assert.equal(badCallbackResponse.statusCode, 400);
  assert.equal(tokenExchanges, 0);

  const callbackResponse = createResponse();
  await controller.handleOAuthCallback({
    query: { state: pendingSession.state, code: 'real-authorization-code' }
  }, callbackResponse);
  assert.equal(callbackResponse.statusCode, 200);
  assert.equal(tokenExchanges, 1);

  const authenticatedResponse = createResponse();
  const authenticatedRequest = { params: { sessionId }, session: createSessionMock() };
  // Present before sign-in and gone after: the session id is rotated at the
  // moment of authentication, so nothing an attacker planted in the
  // pre-login session survives into the logged-in one.
  authenticatedRequest.session.plantedByAttacker = 'should-not-survive';
  await controller.checkAuthStatus(authenticatedRequest, authenticatedResponse);
  assert.equal(authenticatedResponse.body.status, 'authenticated');
  assert.equal(authenticatedResponse.body.username, 'verified_user');
  assert.deepEqual(authenticatedResponse.body.authorizedUniverseIds, ['3828411582']);
  assert.equal(authenticatedResponse.body.canCreatePass, true);
  assert.equal(authenticatedRequest.session.userId, 1);
  assert.equal(authenticatedRequest.session.robloxAccessToken, 'short-lived-token');
  assert.equal(authenticatedRequest.session.plantedByAttacker, undefined);
}

async function testRealGamePassOrder() {
  let apiRequest;
  let storedOrder;
  // Orders are placed against a fixed package, and every price input is read
  // server-side — the request body carries only the package id.
  const dbHelpers = {
    getSetting(key, callback) {
      const values = {
        price_per_100_robux_mnt: '4500',
        level_thresholds: '[]',
        bank_name: 'Khan Bank',
        bank_account_number: '5000123456',
        bank_account_holder: 'RBX LLC'
      };
      callback(null, { value: values[key] ?? '' });
    },
    getPackageById(id, callback) {
      assert.equal(id, 3);
      callback(null, { id: 3, robux_amount: 800, price_mnt: 36000, discount_percent: 0, is_active: 1 });
    },
    getActiveEvent(callback) { callback(null, null); },
    getUserPurchasedTotal(userId, callback) { callback(null, 0); },
    getPhoneLinkByUserId(userId, callback) { callback(null, { id: 1, phone_number: '88112233', user_id: userId }); },
    getActiveOrderForUser(userId, callback) { callback(null, null); },
    isPaymentReferenceTaken(reference, callback) { callback(null, false); },
    createGamePassOrder(...args) {
      const callback = args.pop();
      storedOrder = args;
      callback(null, { id: 41 });
    }
  };
  const oauth = {
    async createGamePass(request) {
      apiRequest = request;
      return { gamePassId: '987654321', price: request.price };
    }
  };
  const controller = new GamePassController(dbHelpers, oauth);
  const response = createResponse();

  await controller.createGamePass({
    body: {
      universeId: '3828411582',
      name: '800 Robux захиалга',
      description: 'RBX / УБ',
      packageId: 3
    },
    session: {
      userId: 7,
      robloxAccessToken: 'short-lived-token',
      robloxAccessTokenExpiresAt: Date.now() + 60_000,
      authorizedUniverseIds: ['3828411582']
    }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(apiRequest.price, 1143);
  assert.equal(apiRequest.universeId, '3828411582');
  assert.equal(storedOrder[3], 800);
  assert.equal(storedOrder[4], '987654321');
  assert.equal(storedOrder[6], 1143);
  assert.equal(storedOrder[7], 36000);
  assert.equal(storedOrder[8], 4500);
  assert.equal(response.body.amountMnt, 36000);
  assert.equal(response.body.status, 'awaiting_payment');
  assert.equal(response.body.purchaseUrl, 'https://www.roblox.com/game-pass/987654321');

  // The pass name and description are delivery plumbing, so the server
  // writes them and the buyer is never asked. The payment reference has to
  // appear in the name: it is the only string tying the Roblox pass back to
  // a bank transfer when an admin reconciles one.
  assert.ok(
    apiRequest.name.includes(response.body.paymentReference),
    `pass name should carry the payment reference, got "${apiRequest.name}"`
  );
  assert.ok(apiRequest.name.length <= 50, 'Roblox caps pass names at 50 characters');
  assert.ok(apiRequest.description.includes(response.body.paymentReference));
  // Whatever the client sent for these is ignored outright.
  assert.ok(!apiRequest.name.includes('800 Robux захиалга'));

  // One authorized universe is not a choice, so omitting it is valid and the
  // server fills it in.
  const autoResponse = createResponse();
  await controller.createGamePass({
    body: { packageId: 3 },
    session: {
      userId: 7,
      robloxAccessToken: 'token',
      robloxAccessTokenExpiresAt: Date.now() + 60_000,
      authorizedUniverseIds: ['3828411582']
    }
  }, autoResponse);
  assert.equal(autoResponse.statusCode, 200);
  assert.equal(apiRequest.universeId, '3828411582');

  // Auto-selection fills a gap; it never overrides. Naming a universe we were
  // not granted stays a refusal rather than quietly building against another.
  const forbiddenResponse = createResponse();
  await controller.createGamePass({
    body: { universeId: '999', name: 'No access', packageId: 3 },
    session: {
      userId: 7,
      robloxAccessToken: 'token',
      robloxAccessTokenExpiresAt: Date.now() + 60_000,
      authorizedUniverseIds: ['3828411582']
    }
  }, forbiddenResponse);
  assert.equal(forbiddenResponse.statusCode, 403);

  // No experience at all: the route cannot run, and the error has to point at
  // the group instead of leaving the buyer stuck.
  const noUniverseResponse = createResponse();
  await controller.createGamePass({
    body: { packageId: 3 },
    session: {
      userId: 7,
      robloxAccessToken: 'token',
      robloxAccessTokenExpiresAt: Date.now() + 60_000,
      authorizedUniverseIds: []
    }
  }, noUniverseResponse);
  assert.equal(noUniverseResponse.statusCode, 403);
  assert.equal(noUniverseResponse.body.reason, 'no_authorized_universe');

  // Several experiences: the buyer genuinely has to pick, so silence is an
  // error rather than an arbitrary guess.
  const ambiguousResponse = createResponse();
  await controller.createGamePass({
    body: { packageId: 3 },
    session: {
      userId: 7,
      robloxAccessToken: 'token',
      robloxAccessTokenExpiresAt: Date.now() + 60_000,
      authorizedUniverseIds: ['3828411582', '111222333']
    }
  }, ambiguousResponse);
  assert.equal(ambiguousResponse.statusCode, 400);
  assert.equal(ambiguousResponse.body.reason, 'universe_required');
}

async function testSellerOwnershipVerification() {
  const originalGet = axios.get;
  const originalKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
  const originalSeller = process.env.ROBLOX_SELLER_USER_ID;
  let request;
  process.env.ROBLOX_OPEN_CLOUD_API_KEY = 'inventory-test-key';
  process.env.ROBLOX_SELLER_USER_ID = '123456789';
  axios.get = async (url, options) => {
    request = { url, options };
    return { data: { inventoryItems: [{ gamePassDetails: { gamePassId: '987654321' } }] } };
  };

  try {
    const verification = await RobloxAuth.verifySellerOwnsGamePass('987654321');
    assert.equal(verification.owned, true);
    assert.equal(verification.sellerUserId, '123456789');
    assert.equal(
      request.url,
      'https://apis.roblox.com/cloud/v2/users/123456789/inventory-items'
    );
    assert.equal(request.options.headers['x-api-key'], 'inventory-test-key');
    assert.equal(request.options.params.filter, 'gamePassIds=987654321');
  } finally {
    axios.get = originalGet;
    if (originalKey === undefined) delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    else process.env.ROBLOX_OPEN_CLOUD_API_KEY = originalKey;
    if (originalSeller === undefined) delete process.env.ROBLOX_SELLER_USER_ID;
    else process.env.ROBLOX_SELLER_USER_ID = originalSeller;
  }
}

async function testAdminPaymentGate() {
  // Starts where a real order sits when an admin first sees it: the buyer has
  // uploaded a receipt and it's waiting on a decision.
  let status = ORDER_STATUS.PAYMENT_SUBMITTED;
  let sellerOwnsPass = false;
  let savedPasswordHash;
  const referralCreditCalls = [];
  const dbHelpers = {
    getAdminCount(callback) {
      callback(null, 2);
    },
    // Mirrors the real guarded transition: the update only lands when the row
    // is still in one of the expected `from` states, which is what makes
    // concurrent callers safe.
    transitionOrderStatus(id, fromStatuses, toStatus, extraColumns, callback) {
      const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
      const changes = id === 41 && from.includes(status) ? 1 : 0;
      if (changes) status = toStatus;
      callback(null, { changes });
    },
    getGamePassById(id, callback) {
      callback(null, id === 41 ? {
        id,
        status,
        delivery_method: 'gamepass',
        roblox_gamepass_id: '987654321'
      } : null);
    },
    appendAuditLog(entry, callback) {
      callback(null, { id: 1 });
    },
    // Completing an order credits any referral commission attached to it.
    // This order has no referrer, so nothing is credited — the stubs exist so
    // the call resolves rather than being swallowed by the service's
    // never-break-the-order error handling.
    creditReferralEarning(orderId, callback) {
      referralCreditCalls.push(orderId);
      callback(null, { changes: 0 });
    },
    reverseReferralEarning(orderId, callback) {
      callback(null, { changes: 0 });
    },
    updateAdminPassword(id, passwordHash, callback) {
      savedPasswordHash = passwordHash;
      callback(null, { changes: id === 3 ? 1 : 0 });
    }
  };
  const controller = new AdminController(
    dbHelpers,
    async (username, password) => ({
      success: username === 'admin' && password === 'current-password',
      adminId: 3,
      username
    }),
    null,
    {
      async verifySellerOwnsGamePass(gamePassId) {
        assert.equal(gamePassId, '987654321');
        return { owned: sellerOwnsPass, sellerUserId: '123456789' };
      }
    }
  );

  const registration = createResponse();
  await controller.register({
    body: { username: 'attacker', password: 'not-used' }
  }, registration);
  assert.equal(registration.statusCode, 403);

  const passwordChange = createResponse();
  await controller.changePassword({
    body: { currentPassword: 'current-password', newPassword: 'new-password-123' },
    session: { adminId: 3, adminUsername: 'admin' }
  }, passwordChange);
  assert.equal(passwordChange.statusCode, 200);
  assert.equal(await bcrypt.compare('new-password-123', savedPasswordHash), true);

  const adminSession = { session: { adminId: 3, adminUsername: 'admin' } };

  // Fulfilment must be unreachable until a human has approved the payment.
  const earlyPurchase = createResponse();
  await controller.markOrderPurchased({ params: { id: '41' }, ...adminSession }, earlyPurchase);
  assert.equal(earlyPurchase.statusCode, 409);
  assert.equal(status, ORDER_STATUS.PAYMENT_SUBMITTED);

  const payment = createResponse();
  await controller.markOrderPaymentReceived({ params: { id: '41' }, ...adminSession }, payment);
  assert.equal(payment.statusCode, 200);
  assert.equal(status, ORDER_STATUS.FULFILLMENT_PENDING);

  // Verification failing must release the delivery claim, not strand the
  // order in FULFILLMENT_PROCESSING — nothing was purchased, so it stays
  // retryable.
  const missingOwnership = createResponse();
  await controller.markOrderPurchased({ params: { id: '41' }, ...adminSession }, missingOwnership);
  assert.equal(missingOwnership.statusCode, 409);
  assert.equal(status, ORDER_STATUS.FULFILLMENT_PENDING);

  sellerOwnsPass = true;
  const purchase = createResponse();
  await controller.markOrderPurchased({ params: { id: '41' }, ...adminSession }, purchase);
  assert.equal(purchase.statusCode, 200);
  assert.equal(status, ORDER_STATUS.COMPLETED);

  // A completed order can never be re-fulfilled: the claim transition only
  // accepts FULFILLMENT_PENDING, so there is no path back into delivery.
  const replay = createResponse();
  await controller.markOrderPurchased({ params: { id: '41' }, ...adminSession }, replay);
  assert.equal(replay.statusCode, 409);
  assert.equal(status, ORDER_STATUS.COMPLETED);

  // Referral commission is credited from the COMPLETED transition, so it
  // fires exactly once — on the delivery, not on the approval, and not again
  // on the replay attempt above.
  assert.deepEqual(referralCreditCalls, [41]);
}

(async () => {
  await testAuthorizationUrl();
  await testVerifiedCallbackFlow();
  await testRealGamePassOrder();
  await testSellerOwnershipVerification();
  await testAdminPaymentGate();
  console.log('OAuth, MNT payment gate, and Roblox ownership verification tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
