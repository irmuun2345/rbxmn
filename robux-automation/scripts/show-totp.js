#!/usr/bin/env node

// Read-only. Prints the code the stored authenticator seed produces right
// now, so it can be held next to the phone that is supposed to agree with it.
//
// A payout that fails 2FA says only "check the server time and the secret",
// and those two causes need opposite fixes. If the number here matches the
// authenticator, the seed is right and the clock is right, and the refusal is
// Roblox's rather than ours.
//
//   node scripts/show-totp.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../config/.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.local'), override: true });

const { dbHelpers } = require('../src/models/db');
const { decryptSecret } = require('../src/services/credentials');
const { generateTotp } = require('../src/services/totp');

dbHelpers.getActiveSellerBot((error, bot) => {
  if (error) {
    console.error('Could not read the bot row:', error.message);
    process.exit(1);
  }
  if (!bot) {
    console.error('No active bot account is connected.');
    process.exit(1);
  }

  const secret = bot.totp_secret;
  if (!secret) {
    console.error('The bot has no authenticator seed stored.');
    process.exit(1);
  }

  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(`bot            ${bot.username}`);
  console.log(`server UTC     ${new Date().toISOString()}`);
  console.log('');
  console.log(`  CODE NOW     ${generateTotp(secret, { offsetSteps: 0 })}   (${left}s left)`);
  console.log(`  next         ${generateTotp(secret, { offsetSteps: 1 })}`);
  console.log(`  previous     ${generateTotp(secret, { offsetSteps: -1 })}`);
  console.log('');
  console.log('Matches your authenticator app -> the seed is correct.');
  console.log('Does not match                 -> re-enter the seed in Admin.');
  process.exit(0);
});
