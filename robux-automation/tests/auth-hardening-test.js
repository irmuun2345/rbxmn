const assert = require('assert');
const AuthController = require('../src/controllers/auth-controller');
const { ReceiptController } = require('../src/controllers/receipt-controller');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

function createSessionMock() {
  return {
    regenerate(callback) {
      Object.keys(this).forEach((key) => {
        if (typeof this[key] !== 'function') delete this[key];
      });
      callback(null);
    },
    save(callback) { callback(null); },
    destroy(callback) { callback(null); }
  };
}

// ---------------------------------------------------------------------------
// The QR handoff is a bearer credential in a URL
// ---------------------------------------------------------------------------

function createAuthStubs() {
  const rows = new Map();
  const dbHelpers = {
    getSessionById(id, callback) {
      const row = rows.get(id);
      callback(null, row && row.expires_at > Date.now() ? row : null);
    },
    createSession(id, userId, sessionData, expiresAt, callback) {
      rows.set(id, { id, user_id: userId, session_data: sessionData, expires_at: Number(expiresAt) });
      callback(null, { id });
    }
  };
  return { rows, dbHelpers };
}

function seedAuthenticatedSession(rows, sessionId, extra = {}) {
  rows.set(sessionId, {
    id: sessionId,
    user_id: 1,
    session_data: JSON.stringify({
      status: 'authenticated',
      localUserId: 1,
      robloxId: '555',
      username: 'buyer',
      ...extra
    }),
    expires_at: Date.now() + 10 * 60 * 1000
  });
}

async function testHandoffSignsInTheFirstCaller() {
  const { rows, dbHelpers } = createAuthStubs();
  const controller = new AuthController(dbHelpers, {});
  seedAuthenticatedSession(rows, 'handoff-1');

  const req = { params: { sessionId: 'handoff-1' }, session: createSessionMock() };
  const res = createResponse();
  await controller.checkAuthStatus(req, res);

  assert.equal(res.body.status, 'authenticated');
  assert.equal(req.session.userId, 1, 'the legitimate browser must be signed in');
  console.log('  ✓ the first caller is signed in normally');
}

async function testHandoffCannotBeReplayedByAnotherClient() {
  // The session id rides in a URL path — it lands in access logs, browser
  // history, proxy logs and Referer headers. Anyone who reads it out of one
  // of those places could previously replay it for the whole 10-minute
  // window and be handed the account.
  const { rows, dbHelpers } = createAuthStubs();
  const controller = new AuthController(dbHelpers, {});
  seedAuthenticatedSession(rows, 'handoff-2');

  const victim = { params: { sessionId: 'handoff-2' }, session: createSessionMock() };
  await controller.checkAuthStatus(victim, createResponse());
  assert.equal(victim.session.userId, 1);

  // A different browser presenting the same id, with no session of its own.
  const attacker = { params: { sessionId: 'handoff-2' }, session: createSessionMock() };
  const attackerRes = createResponse();
  await controller.checkAuthStatus(attacker, attackerRes);

  assert.equal(attackerRes.statusCode, 410, 'a spent handoff must be refused');
  assert.equal(attacker.session.userId, undefined, 'the replayer must not be signed in');
  console.log('  ✓ a spent handoff cannot be replayed by a second client');
}

async function testLegitimateBrowserCanStillRepoll() {
  // Single-use must not break the real flow: a duplicate in-flight poll, or a
  // refresh from the browser that already holds the session, has to keep
  // working or the fix locks users out of their own login.
  const { rows, dbHelpers } = createAuthStubs();
  const controller = new AuthController(dbHelpers, {});
  seedAuthenticatedSession(rows, 'handoff-3');

  const req = { params: { sessionId: 'handoff-3' }, session: createSessionMock() };
  await controller.checkAuthStatus(req, createResponse());

  const second = createResponse();
  await controller.checkAuthStatus(req, second);

  assert.equal(second.statusCode, 200, 'the owning browser must still get an answer');
  assert.equal(second.body.status, 'authenticated');
  console.log('  ✓ the browser that owns the session can still re-poll');
}

async function testConcurrentPollsDoNotLockOutTheOwner() {
  const { rows, dbHelpers } = createAuthStubs();
  const controller = new AuthController(dbHelpers, {});
  seedAuthenticatedSession(rows, 'handoff-4');

  const req = { params: { sessionId: 'handoff-4' }, session: createSessionMock() };
  const responses = [createResponse(), createResponse()];
  await Promise.all(responses.map((res) => controller.checkAuthStatus(req, res)));

  assert.ok(
    responses.some((res) => res.body?.status === 'authenticated'),
    'at least one concurrent poll must succeed'
  );
  assert.equal(req.session.userId, 1);
  console.log('  ✓ concurrent polls from the same browser still sign it in');
}

// ---------------------------------------------------------------------------
// Upload content vs the client's claim about it
// ---------------------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.7\n%doc');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0x1A, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('VP8 ')
]);
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');

function createReceiptController() {
  const inserted = [];
  return {
    inserted,
    controller: Object.assign(new ReceiptController({}), {
      findExistingBySha: async () => null,
      insert: async (receipt) => { inserted.push(receipt); return { id: inserted.length, ...receipt }; }
    })
  };
}

async function testUploadTypeComesFromBytesNotHeaders() {
  const { controller, inserted } = createReceiptController();

  // multer's file.mimetype is just the Content-Type the client wrote on the
  // multipart part. Claiming image/png over HTML bytes used to store the file
  // as .png and make the admin route serve it back as image/png.
  await assert.rejects(
    controller.storeReceipt(
      { buffer: HTML, mimetype: 'image/png', originalname: 'receipt.png', size: HTML.length },
      'order', 1, 1
    ),
    (error) => error.code === 'RECEIPT_CONTENT_MISMATCH',
    'HTML disguised as PNG must be refused'
  );
  assert.equal(inserted.length, 0, 'nothing should have been recorded');
  console.log('  ✓ HTML claiming to be image/png is refused on content');
}

async function testMimeAndExtensionAreDerivedFromContent() {
  const cases = [
    { buffer: PNG, lie: 'application/pdf', mime: 'image/png', extension: '.png' },
    { buffer: JPEG, lie: 'image/png', mime: 'image/jpeg', extension: '.jpg' },
    { buffer: PDF, lie: 'image/webp', mime: 'application/pdf', extension: '.pdf' },
    { buffer: WEBP, lie: 'image/jpeg', mime: 'image/webp', extension: '.webp' }
  ];

  for (const testCase of cases) {
    const { controller, inserted } = createReceiptController();
    // Written to a temp name derived from the sha, so these do land on disk.
    await controller.storeReceipt(
      { buffer: testCase.buffer, mimetype: testCase.lie, originalname: 'x', size: testCase.buffer.length },
      'order', 1, 1
    );

    const stored = inserted[0];
    assert.equal(stored.mimeType, testCase.mime, `mime must come from the bytes, not "${testCase.lie}"`);
    assert.ok(stored.storedName.endsWith(testCase.extension), `extension must be ${testCase.extension}`);
  }

  console.log('  ✓ stored mime and extension are derived from content, not the claimed header');
}

async function run() {
  await testHandoffSignsInTheFirstCaller();
  await testHandoffCannotBeReplayedByAnotherClient();
  await testLegitimateBrowserCanStillRepoll();
  await testConcurrentPollsDoNotLockOutTheOwner();
  await testUploadTypeComesFromBytesNotHeaders();
  await testMimeAndExtensionAreDerivedFromContent();
  console.log('Auth handoff and upload content validation tests passed');
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
