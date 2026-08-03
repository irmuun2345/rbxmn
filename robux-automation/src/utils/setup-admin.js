const bcrypt = require('bcrypt');
const { dbHelpers } = require('../models/db');

const username = process.env.ADMIN_USERNAME || process.argv[2];
const password = process.env.ADMIN_PASSWORD || process.argv[3];

if (!username || !password || password.length < 12) {
  console.error('Usage: node src/utils/setup-admin.js <username> <password-of-at-least-12-characters>');
  process.exit(1);
}

dbHelpers.getAdminCount((countError, count) => {
  if (countError) throw countError;
  if (count > 0) {
    console.error('An admin already exists. Registration is locked.');
    process.exit(1);
  }

  bcrypt.hash(password, 12, (hashError, passwordHash) => {
    if (hashError) throw hashError;
    dbHelpers.createAdmin(username, passwordHash, (createError) => {
      if (createError) throw createError;
      console.log(`Admin ${username} created.`);
      process.exit(0);
    });
  });
});
