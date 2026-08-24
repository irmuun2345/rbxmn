#!/usr/bin/env node

// Read-only. Answers the one question the admin dashboard cannot: *which*
// step of a group delivery is refusing, and in Roblox's own words.
//
// A failed delivery reaches an admin as a single sentence, and the steps
// before the payout lock leave no trace at all in the database — an expired
// cookie, a CREDENTIAL_KEY that no longer decrypts, and a group the bot has
// no authority in are indistinguishable from each other after the fact. This
// walks the same sequence attemptGroupDelivery() walks and prints what each
// call answered.
//
// Nothing here changes state: no join request is accepted, no payout is sent.
// The payout itself is deliberately not attempted — the group's funds
// endpoint is read instead, which needs the same revenue permission.
//
//   node scripts/diagnose-group.js [robloxUserId]
//
// With no argument it uses the oldest group order still waiting for delivery.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });

const RobloxGroup = require('../src/services/roblox-group');
const { dbHelpers } = require('../src/models/db');

const ask = (fn, ...args) => new Promise((resolve, reject) => {
  fn(...args, (error, row) => (error ? reject(error) : resolve(row)));
});

// Roblox puts the useful half of a refusal in the body, not the status line.
function describe(error) {
  const status = error.response?.status;
  const message = error.response?.data?.errors?.[0]?.message || error.message;
  return status ? `HTTP ${status} — ${message}` : message;
}

const ok = (label, detail) => console.log(`  OK    ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);

async function main() {
  const [, , robloxIdArg] = process.argv;

  console.log('\n1. Settings');
  const groupId = (await ask(dbHelpers.getSetting, 'group_id'))?.value || '';
  const requiredDays = (await ask(dbHelpers.getSetting, 'group_membership_days'))?.value || '14 (default)';
  if (!groupId) return bad('group_id', 'not configured — no group order can deliver');
  ok('group_id', groupId);
  ok('group_membership_days', requiredDays);

  console.log('\n2. Bot account');
  let bot;
  try {
    bot = await ask(dbHelpers.getActiveSellerBot);
  } catch (error) {
    // Decryption is the first thing a group delivery does and the first thing
    // that breaks when CREDENTIAL_KEY differs between environments.
    return bad('stored credentials', `${error.message} (CREDENTIAL_KEY mismatch?)`);
  }
  if (!bot) return bad('active bot', 'none configured');
  ok('active bot row', `${bot.username} (${bot.roblox_id})`);
  ok('credentials decrypted', bot.totp_secret ? 'cookie + 2FA secret' : 'cookie only, no 2FA secret');

  console.log('\n3. Is the cookie still alive?');
  try {
    const who = await RobloxGroup.getAuthenticatedBotUser(bot.cookie);
    ok('signed in as', `${who.username} (${who.robloxId})`);
    if (who.robloxId !== String(bot.roblox_id)) {
      bad('identity', `the cookie belongs to ${who.robloxId}, not the stored ${bot.roblox_id}`);
    }
  } catch (error) {
    return bad('cookie', `${describe(error)} — reconnect the bot in /admin.html`);
  }

  console.log('\n4. The group');
  const info = await RobloxGroup.getGroupInfo(groupId);
  ok('group', `${info.name} (${groupId})`);
  const owns = String(bot.roblox_id) === info.ownerId;
  (owns ? ok : bad)('bot owns the group', owns ? 'yes' : `owner is ${info.ownerUsername || info.ownerId}`);

  console.log('\n5. Permissions the delivery actually needs');
  // Reading the group's balance needs the same revenue permission a payout
  // does, so it stands in for one without moving any Robux.
  try {
    const funds = await RobloxGroup.getGroupFunds(groupId, bot.cookie);
    if (funds === null) bad('read group funds', 'answered, but with no usable balance');
    else ok('read group funds', `${funds} R$ available`);
  } catch (error) {
    bad('read group funds', `${describe(error)} — the payout will be refused the same way`);
  }

  let robloxId = robloxIdArg;
  if (!robloxId) {
    const pending = await ask(dbHelpers.getGamePassOrders);
    const order = (pending || []).find((row) => row.delivery_method === 'group'
      && row.status === 'fulfillment_pending');
    if (order) {
      robloxId = order.roblox_id;
      console.log(`\n  (using order #${order.id}, buyer ${robloxId})`);
    }
  }

  if (!robloxId) {
    console.log('\n  No pending group order and no Roblox id given — skipping the buyer checks.');
    return;
  }

  console.log('\n6. The buyer');
  const member = await RobloxGroup.isGroupMember(groupId, robloxId);
  (member ? ok : bad)('in the group', member ? 'yes' : 'no — waiting on a join request');

  try {
    const request = await RobloxGroup.getJoinRequest(groupId, robloxId, bot.cookie);
    ok('read join requests', request ? 'one is pending' : 'none pending');
  } catch (error) {
    // This is step 1 of every group delivery, and it runs before the order is
    // locked — which is why a failure here leaves nothing behind in the
    // database to explain itself.
    bad('read join requests', describe(error));
  }
}

main()
  .catch((error) => {
    console.error('\nDiagnosis stopped:', error.message);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 250));
