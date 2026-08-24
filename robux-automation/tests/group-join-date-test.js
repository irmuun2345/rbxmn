const assert = require('assert');

const applySchema = require('../src/models/schema');
const createGroupMembershipRepository = require('../src/models/repositories/group-memberships');
const createUserRepository = require('../src/models/repositories/users');
const { temporaryDatabase, all, discard, settle } = require('./helpers/temporary-database');

// Crediting the time someone has actually been in the group.
//
// Roblox will not pay out group funds to an account that has not been a
// member long enough, so the app keeps its own clock. The classic Groups API
// reports *that* an account is a member but never *when* it joined, so anyone
// already in the group when we first looked had their clock started from that
// moment — and a customer who had genuinely been a member for a year was told
// to wait another fourteen days.
//
// Open Cloud's membership resource carries the real join date. These tests
// cover using it, and — more importantly — the guards that stop the same
// mechanism being used to move a clock the wrong way.

const GROUP_ID = '16748972';
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

async function withRepository(body) {
  const db = temporaryDatabase();
  try {
    applySchema(db);
    await settle(db);

    const users = createUserRepository(db);
    const memberships = createGroupMembershipRepository(db);

    const user = await new Promise((resolve, reject) => {
      users.createUser('buyer', 4705093054, (e, row) => (e ? reject(e) : resolve(row)));
    });

    const record = (joinedAt, source) => new Promise((resolve, reject) => {
      memberships.recordGroupMembership(
        user.id, '4705093054', GROUP_ID, joinedAt, source,
        (e, row) => (e ? reject(e) : resolve(row))
      );
    });

    const correct = (joinedAt, source) => new Promise((resolve, reject) => {
      memberships.correctObservedJoinDate(
        user.id, GROUP_ID, joinedAt, source,
        (e, row) => (e ? reject(e) : resolve(row))
      );
    });

    const read = async () => (await all(
      db, 'SELECT * FROM group_memberships WHERE user_id = ? AND group_id = ?', [user.id, GROUP_ID]
    ))[0];

    await body({ record, correct, read, db });
  } finally {
    await discard(db);
  }
}

async function testGuessIsCorrectedToTheRealDate() {
  await withRepository(async ({ record, correct, read }) => {
    // The state every existing customer is in: seen today, clock started today.
    await record(iso(0), 'observed');
    const before = await read();
    assert.equal(before.source, 'observed');

    // Open Cloud says they actually joined over a year ago.
    const realJoin = iso(-400 * DAY);
    const result = await correct(realJoin, 'open_cloud');
    assert.equal(result.changes, 1, 'the guessed clock must be corrected');

    const after = await read();
    assert.equal(new Date(after.joined_at).toISOString(), realJoin);
    assert.equal(after.source, 'open_cloud', 'the row must record that it is now authoritative');

    console.log('  ✓ a guessed join date is replaced by the real one');
  });
}

async function testCorrectionCannotPushAClockForward() {
  await withRepository(async ({ record, correct, read }) => {
    const longAgo = iso(-400 * DAY);
    await record(longAgo, 'observed');

    // A later date would take eligibility *away* from someone who already has
    // it. The guard is in the WHERE clause, so no caller can do this.
    const result = await correct(iso(-1 * DAY), 'open_cloud');
    assert.equal(result.changes, 0, 'a later join date must be refused');
    assert.equal(new Date((await read()).joined_at).toISOString(), longAgo, 'the clock must not move');

    console.log('  ✓ a correction can never move a clock forward');
  });
}

async function testAcceptedJoinsAreNeverOverwritten() {
  await withRepository(async ({ record, correct, read }) => {
    // We watched this one happen, so it is already exact. Open Cloud must not
    // get to second-guess it — not even with an earlier date.
    const watched = iso(-2 * DAY);
    await record(watched, 'accepted');

    const result = await correct(iso(-400 * DAY), 'open_cloud');
    assert.equal(result.changes, 0, 'an exact record must not be overwritten');

    const after = await read();
    assert.equal(new Date(after.joined_at).toISOString(), watched);
    assert.equal(after.source, 'accepted');

    console.log('  ✓ a join we witnessed is never overwritten');
  });
}

async function testCorrectionIsIdempotent() {
  await withRepository(async ({ record, correct, read }) => {
    await record(iso(0), 'observed');
    const realJoin = iso(-400 * DAY);

    assert.equal((await correct(realJoin, 'open_cloud')).changes, 1);
    // Second pass: the row is no longer 'observed', so it is left alone. This
    // is what stops every eligibility check rewriting the same row forever.
    assert.equal((await correct(realJoin, 'open_cloud')).changes, 0, 'a corrected row must settle');

    assert.equal(new Date((await read()).joined_at).toISOString(), realJoin);
    console.log('  ✓ correcting twice changes nothing the second time');
  });
}

async function testEligibilityFollowsTheCorrectedDate() {
  const { daysSince, DEFAULT_REQUIRED_DAYS } = require('../src/services/group-eligibility');

  await withRepository(async ({ record, correct, read }) => {
    await record(iso(0), 'observed');
    assert.ok(
      daysSince((await read()).joined_at) < DEFAULT_REQUIRED_DAYS,
      'a freshly guessed clock must not be eligible'
    );

    await correct(iso(-400 * DAY), 'open_cloud');
    assert.ok(
      daysSince((await read()).joined_at) >= DEFAULT_REQUIRED_DAYS,
      'the corrected clock must make a long-standing member eligible'
    );

    console.log('  ✓ a long-standing member becomes eligible once corrected');
  });
}

// The lookup must never throw into the payout path, and must refuse dates
// that would hand someone eligibility they have not earned.
async function testJoinDateLookupIsDefensive() {
  const { fetchGroupJoinDate } = require('../src/services/roblox-open-cloud');

  const savedKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
  try {
    delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    assert.equal(await fetchGroupJoinDate(GROUP_ID, '123'), null, 'no API key must yield null, not a throw');

    process.env.ROBLOX_OPEN_CLOUD_API_KEY = 'test-key';
    assert.equal(await fetchGroupJoinDate('not-a-group', '123'), null, 'a non-numeric group id is refused');
    assert.equal(await fetchGroupJoinDate(GROUP_ID, "1' OR '1"), null, 'a non-numeric user id is refused');
  } finally {
    if (savedKey === undefined) delete process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    else process.env.ROBLOX_OPEN_CLOUD_API_KEY = savedKey;
  }

  console.log('  ✓ the join-date lookup fails closed instead of throwing');
}

async function main() {
  await testGuessIsCorrectedToTheRealDate();
  await testCorrectionCannotPushAClockForward();
  await testAcceptedJoinsAreNeverOverwritten();
  await testCorrectionIsIdempotent();
  await testEligibilityFollowsTheCorrectedDate();
  await testJoinDateLookupIsDefensive();
  console.log('Group join date tests passed');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
