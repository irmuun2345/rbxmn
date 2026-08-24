const assert = require('assert');
const { ACTION, describeDeliveryFailure } = require('../src/services/delivery-errors');

// What an admin is told about a failed delivery is not cosmetic. One of these
// messages is the only thing standing between a stranded order and an admin
// clicking "deliver" a second time on a payout Roblox may already have
// applied — so the wording is pinned down here alongside the money rules.

const tag = (error, extra) => Object.assign(error, extra);

function testAmbiguousFailureIsNeverATryAgain() {
  // The exact shape group-delivery.js rethrows after stranding an order.
  const failure = describeDeliveryFailure(tag(new Error('socket hang up'), {
    payoutAttempted: true,
    payoutMayHaveLanded: true
  }));

  assert.equal(failure.action, ACTION.RESOLVE);
  assert.match(failure.message, /Дахин бүү илгээ/);
  assert.match(failure.message, /Гацсан захиалга/);
  // The old wording. It must not survive anywhere on this path.
  assert.doesNotMatch(failure.message, /Дахин оролдоно уу/);

  console.log('  ✓ a payout that may have landed is never described as retryable');
}

function testAmbiguityOutranksEveryOtherSignal() {
  // A 500 would otherwise map to "retry". Once the payout body was on the
  // wire, that reading is wrong no matter what Roblox answered with.
  const failure = describeDeliveryFailure(tag(new Error('Server Error'), {
    payoutAttempted: true,
    payoutMayHaveLanded: true,
    response: { status: 500, data: { errors: [{ message: 'InternalServerError' }] } }
  }));

  assert.equal(failure.action, ACTION.RESOLVE);
  assert.equal(failure.httpStatus, 409);

  console.log('  ✓ ambiguity outranks the HTTP status underneath it');
}

function testNeverSentFailuresSayNoRobuxMoved() {
  const failure = describeDeliveryFailure(tag(new Error('no token'), { csrfFailure: true }));

  assert.equal(failure.action, ACTION.FIX);
  assert.match(failure.message, /Robux хөдлөөгүй/);

  console.log('  ✓ a never-sent failure says so, so the order can be requeued without fear');
}

function testConfigurationFailuresPointAtTheSetting() {
  const cases = [
    ['CREDENTIAL_DECRYPT_FAILED', /CREDENTIAL_KEY/],
    ['GROUP_NOT_CONFIGURED', /Группын тохиргоо/],
    ['INSUFFICIENT_GROUP_FUNDS', /цэнэглээд/],
    ['TWO_STEP_FAILED', /Серверийн цаг/]
  ];

  for (const [code, expected] of cases) {
    const failure = describeDeliveryFailure(tag(new Error('оригинал мессеж'), { code }));
    assert.equal(failure.action, ACTION.FIX, `${code} is a configuration fault, not a retry`);
    assert.equal(failure.httpStatus, 409);
    assert.match(failure.message, expected, `${code} should name what to change`);
  }

  console.log('  ✓ configuration failures name the setting to change');
}

function testHttpStatusesAreTranslated() {
  const unauthorised = describeDeliveryFailure({
    message: 'Request failed',
    response: { status: 401, data: { errors: [{ message: 'Authorization has been denied' }] } }
  });
  assert.equal(unauthorised.action, ACTION.FIX);
  assert.match(unauthorised.message, /cookie/i);
  // Roblox's own words survive alongside the translation.
  assert.match(unauthorised.message, /Authorization has been denied/);

  const rateLimited = describeDeliveryFailure({ message: 'x', response: { status: 429, data: {} } });
  assert.equal(rateLimited.action, ACTION.RETRY);
  assert.equal(rateLimited.httpStatus, 502);

  const offline = describeDeliveryFailure(Object.assign(new Error('ECONNABORTED'), {}));
  assert.equal(offline.action, ACTION.RETRY);

  console.log('  ✓ Roblox status codes become instructions, keeping Roblox\'s own text');
}

function run() {
  testAmbiguousFailureIsNeverATryAgain();
  testAmbiguityOutranksEveryOtherSignal();
  testNeverSentFailuresSayNoRobuxMoved();
  testConfigurationFailuresPointAtTheSetting();
  testHttpStatusesAreTranslated();
  console.log('Delivery failure message tests passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
