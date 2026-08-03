// The two things that tie a Roblox account to a real person's standing with
// us: their phone number, and how long they have been in our payout group.

const { run, seedSettings } = require('./helpers');

module.exports = function applyIdentitySchema(db) {
  run(db, 'phone_links table', `CREATE TABLE IF NOT EXISTS phone_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  // One Roblox account (user_id) can only ever hold one phone number — this
  // is what stops a levelled-up/discounted identity from being spread across
  // multiple Roblox accounts. Enforced as an index rather than a column
  // constraint since the table may already exist from an earlier version.
  run(db, 'phone_links user_id unique index',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_links_user_id ON phone_links (user_id)');

  // When each account became a member of our payout group.
  //
  // This table exists because Roblox's group APIs report *that* a user is a
  // member but never *when* they joined — and the platform's payout rule is
  // expressed in days of membership. So we record the clock ourselves.
  //
  // `source` distinguishes how we learned the date:
  //   'accepted' — we accepted their join request, so joined_at is exact.
  //   'observed' — they were already a member the first time we looked, so
  //                joined_at is when we noticed, not when they joined. That
  //                is deliberately conservative: it can only ever delay
  //                eligibility, never grant it early.
  run(db, 'group_memberships table', `CREATE TABLE IF NOT EXISTS group_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    roblox_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    joined_at DATETIME NOT NULL,
    source TEXT NOT NULL DEFAULT 'observed',
    last_verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  // One row per account per group — the clock for an account can't be
  // restarted (or forked) by creating a second record.
  run(db, 'group membership index',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_group_memberships_user_group
     ON group_memberships (user_id, group_id)`);

  seedSettings(db, [['group_membership_days', '14']]);
};
