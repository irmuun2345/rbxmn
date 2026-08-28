const assert = require('assert');

const applySchema = require('../src/models/schema');
const referrals = require('../src/services/referrals');
const { temporaryDatabase, run, all, discard, settle } = require('./helpers/temporary-database');

// A referral code is a budget, not an open invitation: an admin issues it to
// one account and says how many customers may ever redeem it.
//
// The cap is enforced inside the INSERT that binds a customer, which is the
// only place it can be enforced honestly — a count-then-insert leaves a gap
// two customers can both pass through. That SQL is what these tests are
// about, so they run it against real Postgres (PGlite) rather than a stub
// that would simply agree with whatever the service asked it.

const REPOSITORIES = [
  require('../src/models/repositories/users'),
  require('../src/models/repositories/referrals'),
  require('../src/models/repositories/settings')
];

// The same composition db.js performs, over a throwaway database.
function helpersFor(db) {
  return REPOSITORIES.reduce((helpers, build) => Object.assign(helpers, build(db)), {});
}

async function freshDatabase() {
  const db = temporaryDatabase();
  applySchema(db);
  await settle(db);
  return db;
}

async function addUser(db, username) {
  await run(db, 'INSERT INTO users (username) VALUES (?)', [username]);
  const rows = await all(db, 'SELECT id FROM users WHERE username = ?', [username]);
  return rows[0].id;
}

// Binding is what consumes a use, so the tests need customers who are allowed
// to bind: no completed orders, which is the default for a brand new account.
async function testCapClosesTheCode() {
  const db = await freshDatabase();

  try {
    const dbHelpers = helpersFor(db);
    const ownerId = await addUser(db, 'creator');

    const issued = await referrals.issueCodeForOwner(dbHelpers, {
      ownerUserId: ownerId,
      rawCode: 'sunee',
      maxUses: 2,
      bonusPercent: 3,
      commissionPercent: 5,
      adminId: 1
    });

    assert.equal(issued.code, 'SUNEE', 'the code must be stored uppercase');
    assert.equal(issued.maxUses, 2);

    const first = await referrals.bindCodeToUser(dbHelpers, await addUser(db, 'buyer1'), 'SUNEE');
    assert.equal(first.remainingUses, 1, 'one of the two slots must be left');

    // Lower case, because a customer typing the code will not match the
    // creator's capitalisation and must still consume a slot.
    const second = await referrals.bindCodeToUser(dbHelpers, await addUser(db, 'buyer2'), 'sunee');
    assert.equal(second.remainingUses, 0, 'the code must now be spent');

    const thirdUserId = await addUser(db, 'buyer3');
    await assert.rejects(
      () => referrals.bindCodeToUser(dbHelpers, thirdUserId, 'SUNEE'),
      (error) => error.code === 'CODE_EXHAUSTED',
      'the third customer must be refused once the budget is used up'
    );

    // Refused means nothing was written — a rejected customer who is left
    // attributed anyway would earn the creator commission on every order.
    const bound = await all(db,
      'SELECT referee_user_id FROM referral_attributions WHERE referee_user_id = ?', [thirdUserId]);
    assert.equal(bound.length, 0, 'a refused customer must not be attributed');

    console.log('  ✓ a capped code stops accepting customers once its budget is spent');
  } finally {
    await discard(db);
  }
}

// The cap counts the whole code, not each customer: anyone may redeem it
// until it is spent, and 0 means there is no limit at all.
async function testZeroMeansUncapped() {
  const db = await freshDatabase();

  try {
    const dbHelpers = helpersFor(db);
    const ownerId = await addUser(db, 'creator');

    await referrals.issueCodeForOwner(dbHelpers, {
      ownerUserId: ownerId, rawCode: 'OPEN', maxUses: 0
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await referrals.bindCodeToUser(dbHelpers, await addUser(db, `buyer${i}`), 'OPEN');
      assert.equal(result.remainingUses, null, 'an uncapped code must not report a remaining count');
    }

    const uses = await all(db, 'SELECT COUNT(*) AS n FROM referral_attributions');
    assert.equal(Number(uses[0].n), 5);

    console.log('  ✓ a cap of 0 leaves the code open');
  } finally {
    await discard(db);
  }
}

// Two customers racing for the last slot. The INSERT guard is what decides
// this; a count-then-insert would let both through and overspend the budget.
async function testConcurrentRedemptionCannotOverspend() {
  const db = await freshDatabase();

  try {
    const dbHelpers = helpersFor(db);
    const ownerId = await addUser(db, 'creator');
    await referrals.issueCodeForOwner(dbHelpers, {
      ownerUserId: ownerId, rawCode: 'LAST', maxUses: 1
    });

    const racers = [await addUser(db, 'racer1'), await addUser(db, 'racer2')];
    const outcomes = await Promise.allSettled(
      racers.map((userId) => referrals.bindCodeToUser(dbHelpers, userId, 'LAST'))
    );

    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    assert.equal(won.length, 1, 'exactly one of the two may take the last slot');
    assert.equal(
      outcomes.find((outcome) => outcome.status === 'rejected').reason.code,
      'CODE_EXHAUSTED'
    );

    const uses = await all(db, 'SELECT COUNT(*) AS n FROM referral_attributions');
    assert.equal(Number(uses[0].n), 1, 'the budget must not be overspent');

    console.log('  ✓ two customers racing for the last slot cannot both take it');
  } finally {
    await discard(db);
  }
}

// Both percentages come out of the margin on the order, so the band they may
// be set to is narrow. 0 is the one value outside it that is allowed, and it
// means that half of the programme is switched off.
function testPercentBand() {
  assert.equal(referrals.normalisePercent(1, 'Бонус'), 1);
  assert.equal(referrals.normalisePercent(5, 'Бонус'), 5);
  assert.equal(referrals.normalisePercent(0, 'Бонус'), 0, '0 switches that half off');
  assert.equal(referrals.normalisePercent(null, 'Бонус'), null, 'null follows the global setting');
  assert.equal(referrals.normalisePercent('', 'Бонус'), null);

  for (const rejected of [6, 50, 0.5, -1]) {
    assert.throws(
      () => referrals.normalisePercent(rejected, 'Бонус'),
      (error) => error.code === 'PERCENT_RANGE',
      `${rejected}% must be refused`
    );
  }

  // A rate stored before the band existed must not keep paying its old value.
  assert.equal(referrals.clampToBand(10), 5, 'a stale 10% is held to the ceiling');
  assert.equal(referrals.clampToBand(0), 0, 'switched off stays switched off');
  assert.equal(referrals.clampToBand(3), 3);

  assert.equal(referrals.normaliseMaxUses(''), 0, 'a blank cap means uncapped');
  assert.equal(referrals.normaliseMaxUses(25), 25);
  assert.throws(
    () => referrals.normaliseMaxUses(-1),
    (error) => error.code === 'MAX_USES_INVALID'
  );

  console.log('  ✓ percentages are held to 1-5% and caps to whole, non-negative numbers');
}

// Lowering the cap below what a code has already given out closes it to new
// customers without retracting the ones already attributed — they have orders
// against those terms, and rewriting that would be rewriting history.
async function testLoweringTheCapKeepsExistingCustomers() {
  const db = await freshDatabase();

  try {
    const dbHelpers = helpersFor(db);
    const ownerId = await addUser(db, 'creator');
    const issued = await referrals.issueCodeForOwner(dbHelpers, {
      ownerUserId: ownerId, rawCode: 'SHRINK', maxUses: 5
    });

    await referrals.bindCodeToUser(dbHelpers, await addUser(db, 'buyer1'), 'SHRINK');
    await referrals.bindCodeToUser(dbHelpers, await addUser(db, 'buyer2'), 'SHRINK');

    await new Promise((resolve, reject) => {
      dbHelpers.updateReferralCodeTerms(issued.id, {
        isInfluencer: false,
        bonusPercentOverride: null,
        commissionPercentOverride: null,
        maxUses: 1,
        isActive: true
      }, (error) => (error ? reject(error) : resolve()));
    });

    const stillBound = await all(db, 'SELECT COUNT(*) AS n FROM referral_attributions');
    assert.equal(Number(stillBound[0].n), 2, 'existing customers keep their attribution');

    const newcomerId = await addUser(db, 'buyer3');
    await assert.rejects(
      () => referrals.bindCodeToUser(dbHelpers, newcomerId, 'SHRINK'),
      (error) => error.code === 'CODE_EXHAUSTED',
      'the code must be closed to new customers'
    );

    console.log('  ✓ lowering a cap closes the code without unbinding anyone');
  } finally {
    await discard(db);
  }
}

async function main() {
  testPercentBand();
  await testCapClosesTheCode();
  await testZeroMeansUncapped();
  await testConcurrentRedemptionCannotOverspend();
  await testLoweringTheCapKeepsExistingCustomers();
  console.log('Referral cap tests passed');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
