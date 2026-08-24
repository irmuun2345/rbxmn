const assert = require('assert');

// The bot account's second factor, and the encryption around the two secrets
// that make it work.
//
// The rule every assertion here defends is the same one payout-safety-test.js
// defends: a payout that Roblox refused must go back in the queue, and a
// payout that may have landed must not be retried. Answering a 2FA challenge
// happens *inside* that decision, so getting it wrong is a way to pay someone
// twice.

// Set before requiring credentials.js, which reads the key on first use.
process.env.CREDENTIAL_KEY = require('crypto').randomBytes(32).toString('base64url');

const { generateTotp, isValidTotpSecret } = require('../src/services/totp');
const credentials = require('../src/services/credentials');
const RobloxGroup = require('../src/services/roblox-group');

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

function testTotpAgainstRfcVectors() {
  // RFC 6238 Appendix B, the SHA-1 rows. The published values are 8 digits;
  // the last six of each are what a six-digit authenticator shows.
  //
  // These pin the implementation to the spec rather than to itself: a code
  // this file both generates and checks would pass while being wrong in
  // exactly the way that makes Roblox reject every payout.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890"
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130']
  ];

  vectors.forEach(([unixSeconds, expected]) => {
    assert.equal(
      generateTotp(secret, { at: unixSeconds * 1000 }),
      expected,
      `RFC 6238 vector at T=${unixSeconds}`
    );
  });

  console.log('  ✓ TOTP codes match the RFC 6238 test vectors');
}

function testTotpWindows() {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const at = 1111111109 * 1000;

  // The drift retry in roblox-group.js depends on this: offsetSteps -1 must
  // produce the code from the previous 30-second window, not a random one.
  assert.equal(generateTotp(secret, { at }), '081804');
  assert.equal(
    generateTotp(secret, { at, offsetSteps: -1 }),
    generateTotp(secret, { at: at - 30000 }),
    'one step back must equal thirty seconds earlier'
  );

  console.log('  ✓ the drift window looks up the previous code, not a random one');
}

function testSecretValidation() {
  // Rejected while the admin is still looking at the form. Every one of these
  // would otherwise be stored happily and produce six plausible digits that
  // Roblox refuses, at 3am, with no clue as to why.
  for (const bad of ['', null, undefined, 'not base32!', '18', 'ABCDEF', 'JBSWY3DPEHPK3PX1']) {
    assert.equal(isValidTotpSecret(bad), false, `${String(bad)} should be refused`);
  }

  // Spaces, lowercase and padding are how authenticators actually display a
  // seed, and how it arrives when pasted back.
  assert.equal(isValidTotpSecret('JBSWY3DPEHPK3PXP'), true);
  assert.equal(isValidTotpSecret('jbswy3dp ehpk3pxp'), true);
  assert.equal(isValidTotpSecret('JBSWY3DPEHPK3PXP===='), true);
  assert.equal(
    generateTotp('jbswy3dp ehpk3pxp'),
    generateTotp('JBSWY3DPEHPK3PXP'),
    'formatting must not change the code'
  );

  console.log('  ✓ authenticator secrets are validated before they are stored');
}

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

function testCredentialRoundTrip() {
  const cookie = '_|WARNING:-DO-NOT-SHARE-THIS.|_' + 'x'.repeat(400);
  const sealed = credentials.encryptSecret(cookie);

  assert.ok(sealed.startsWith('v1:'), 'stored values must be self-describing');
  assert.ok(!sealed.includes('WARNING'), 'the plaintext must not survive in the envelope');
  assert.equal(credentials.decryptSecret(sealed), cookie);

  // Random IV per call, so the same cookie stored twice does not produce two
  // identical rows — which would leak that the credential never changed.
  assert.notEqual(credentials.encryptSecret(cookie), sealed, 'each encryption must use a fresh IV');

  // Encrypting an already-sealed value would nest the envelope, and the
  // decrypt would hand back ciphertext that looks like a valid cookie.
  assert.equal(credentials.encryptSecret(sealed), sealed, 'sealing is idempotent');

  console.log('  ✓ credentials round-trip and never double-seal');
}

function testLegacyPlaintextStillReads() {
  // Rows written before encryption existed. Refusing to read them would take
  // every running install offline at the moment of upgrade.
  assert.equal(credentials.decryptSecret('plain-old-cookie-value'), 'plain-old-cookie-value');
  assert.equal(credentials.isEncrypted('plain-old-cookie-value'), false);

  // Absent values stay absent rather than becoming the string "null" — the
  // 2FA column is null for every bot that has not enrolled.
  assert.equal(credentials.decryptSecret(null), null);
  assert.equal(credentials.encryptSecret(null), null);
  assert.equal(credentials.decryptSecret(''), '');

  console.log('  ✓ plaintext rows from before encryption still read');
}

function testWrongKeyIsLoudNotSilent() {
  const sealed = credentials.encryptSecret('bot-cookie');

  const original = process.env.CREDENTIAL_KEY;
  process.env.CREDENTIAL_KEY = require('crypto').randomBytes(32).toString('base64url');
  credentials.resetKeyCache();

  try {
    // Silently returning an empty cookie here would surface hours later as
    // "Roblox says the bot is logged out", pointing at everything except the
    // key that actually changed.
    assert.throws(() => credentials.decryptSecret(sealed), /decrypt/i);
  } finally {
    process.env.CREDENTIAL_KEY = original;
    credentials.resetKeyCache();
  }

  assert.equal(credentials.decryptSecret(sealed), 'bot-cookie', 'the right key still reads it');
  console.log('  ✓ a changed key fails loudly instead of returning a broken credential');
}

// ---------------------------------------------------------------------------
// Challenge handling
// ---------------------------------------------------------------------------

const CHALLENGE_METADATA = Buffer.from(JSON.stringify({
  userId: '99887766',
  challengeId: 'inner-2sv-challenge'
})).toString('base64');

function challengeError() {
  return Object.assign(new Error('Challenge is required to authorize the request'), {
    response: {
      status: 403,
      headers: {
        'rblx-challenge-id': 'outer-challenge',
        'rblx-challenge-type': 'twostepverification',
        'rblx-challenge-metadata': CHALLENGE_METADATA
      }
    }
  });
}

function csrfError(token = 'rotated-token') {
  return Object.assign(new Error('Token Validation Failed'), {
    response: { status: 403, headers: { 'x-csrf-token': token } }
  });
}

function testChallengeDetection() {
  assert.deepEqual(RobloxGroup.readChallenge(challengeError()), {
    id: 'outer-challenge',
    type: 'twostepverification',
    metadata: CHALLENGE_METADATA
  });

  // A CSRF rotation is also a 403. Confusing the two would send the account
  // down the 2FA path on every stale token, and the CSRF path on every real
  // challenge.
  assert.equal(RobloxGroup.readChallenge(csrfError()), null);
  assert.equal(RobloxGroup.readChallenge(new Error('network down')), null);

  console.log('  ✓ a 2FA challenge is told apart from an ordinary CSRF rotation');
}

async function testMissingSecretIsNeverSent() {
  // The bot has 2FA switched on but no secret stored. This must be a
  // never-sent failure: Roblox refused the payout at the gate, so the order
  // belongs back in the queue, not stranded waiting for a human to work out
  // whether Robux moved.
  await assert.rejects(
    RobloxGroup.solveChallenge(RobloxGroup.readChallenge(challengeError()), 'cookie', null, 'csrf'),
    (error) => error.code === 'TOTP_NOT_CONFIGURED' && error.preflight === true,
    'a missing 2FA secret must be flagged as never-sent'
  );

  // Roblox raising a challenge type nothing here can answer — an emailed code,
  // say — is equally never-sent.
  await assert.rejects(
    RobloxGroup.solveChallenge(
      { id: 'x', type: 'forcetwostepverification', metadata: CHALLENGE_METADATA },
      'cookie', 'JBSWY3DPEHPK3PXP', 'csrf'
    ),
    (error) => error.code === 'UNSUPPORTED_CHALLENGE' && error.preflight === true
  );

  // Unreadable metadata, same argument.
  await assert.rejects(
    RobloxGroup.solveChallenge(
      { id: 'x', type: 'twostepverification', metadata: 'not-base64-json' },
      'cookie', 'JBSWY3DPEHPK3PXP', 'csrf'
    ),
    (error) => error.preflight === true
  );

  console.log('  ✓ every failure while answering a challenge is flagged never-sent');
}

async function withStubbedSolve(result, body) {
  const original = RobloxGroup.solveChallenge;
  RobloxGroup.solveChallenge = async () => result;
  try {
    return await body();
  } finally {
    RobloxGroup.solveChallenge = original;
  }
}

async function withStubbedCsrf(body) {
  const original = RobloxGroup.fetchCsrfToken;
  RobloxGroup.fetchCsrfToken = async () => 'csrf-token';
  try {
    return await body();
  } finally {
    RobloxGroup.fetchCsrfToken = original;
  }
}

async function testChallengeIsSolvedThenRetriedOnce() {
  const solved = { 'rblx-challenge-id': 'outer-challenge' };
  const attempts = [];

  const result = await withStubbedCsrf(() => withStubbedSolve(solved, () => RobloxGroup.withCsrf(
    `cookie-${Date.now()}`,
    async (token, challengeHeaders) => {
      attempts.push({ token, challengeHeaders });
      if (attempts.length === 1) throw challengeError();
      return 'payout-sent';
    },
    { totpSecret: 'JBSWY3DPEHPK3PXP' }
  )));

  assert.equal(result, 'payout-sent');
  assert.equal(attempts.length, 2, 'the refused request is sent exactly once more');
  assert.deepEqual(attempts[0].challengeHeaders, {}, 'the first attempt carries no challenge headers');
  assert.deepEqual(attempts[1].challengeHeaders, solved, 'the retry carries the solved challenge');

  console.log('  ✓ a challenge is answered and the refused request retried exactly once');
}

async function testChallengeAndCsrfRetriesAreBounded() {
  // A payout is not idempotent. If Roblox kept answering 403 and this kept
  // resending, the loop itself would be the bug — so each condition is
  // answered at most once and the whole thing gives up after three attempts.
  let attempts = 0;

  await assert.rejects(
    withStubbedCsrf(() => withStubbedSolve({}, () => RobloxGroup.withCsrf(
      `cookie-${Date.now()}`,
      async () => {
        attempts += 1;
        throw attempts === 1 ? challengeError() : csrfError(`token-${attempts}`);
      },
      { totpSecret: 'JBSWY3DPEHPK3PXP' }
    ))),
    (error) => error.response?.status === 403
  );

  assert.equal(attempts, 3, 'one original attempt, one challenge retry, one CSRF retry — then stop');
  console.log('  ✓ retries are bounded: a payout can never be sent in a loop');
}

async function testAmbiguousFailuresAreNotRetried() {
  // A timeout is the case the whole design turns on: the request was on the
  // wire and Roblox may have applied it. It must escape immediately, with no
  // flag, so group-delivery.js strands the order instead of resending.
  let attempts = 0;

  const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });

  await assert.rejects(
    withStubbedCsrf(() => RobloxGroup.withCsrf(
      `cookie-${Date.now()}`,
      async () => { attempts += 1; throw timeout; },
      { totpSecret: 'JBSWY3DPEHPK3PXP' }
    )),
    (error) => error.code === 'ECONNABORTED' && !error.preflight && !error.csrfFailure
  );

  assert.equal(attempts, 1, 'an ambiguous failure must never be resent');
  console.log('  ✓ an ambiguous failure is not retried and carries no never-sent flag');
}

async function run() {
  testTotpAgainstRfcVectors();
  testTotpWindows();
  testSecretValidation();
  testCredentialRoundTrip();
  testLegacyPlaintextStillReads();
  testWrongKeyIsLoudNotSilent();
  testChallengeDetection();
  await testMissingSecretIsNeverSent();
  await testChallengeIsSolvedThenRetriedOnce();
  await testChallengeAndCsrfRetriesAreBounded();
  await testAmbiguousFailuresAreNotRetried();
  console.log('Bot 2FA and credential encryption tests passed');
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
