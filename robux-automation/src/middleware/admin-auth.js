const bcrypt = require('bcrypt');
const { dbHelpers } = require('../models/db');

// One message for every way a login can fail.
//
// "Admin not found" and "Invalid password" told an attacker which admin
// usernames exist, which is the first half of a password-guessing attack
// handed over for free. The message the browser prints is irrelevant here —
// the distinction was in the HTTP response body, so `curl` could read it.
const LOGIN_FAILED = 'Хэрэглэгчийн нэр эсвэл нууц үг буруу байна.';

// A valid bcrypt digest of a value nothing can match, compared against when
// the username does not exist.
//
// Without it the two branches take visibly different times: bcrypt.compare is
// ~100ms of deliberate work, and skipping it makes "no such admin" answer an
// order of magnitude faster than "wrong password". That timing difference is
// the same oracle the shared message above closes, just measured instead of
// read.
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8e1WQ1kQ8Jx7Q0LZ2VYNC5wBvJ0dTu';

// Middleware to check if admin is authenticated
function requireAdminAuth(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  // Shaped like every other error this API returns, so the dashboard's
  // request() helper reports it the same way as any other failure.
  return res.status(401).json({ success: false, error: 'Админаар нэвтэрнэ үү.' });
}

// Admin login function
async function adminLogin(username, password) {
  return new Promise((resolve, reject) => {
    dbHelpers.getAdminByUsername(username, async (err, admin) => {
      if (err) {
        reject(err);
        return;
      }

      try {
        // Always runs, so an unknown username costs the same as a wrong
        // password. The result for the dummy hash is discarded.
        const isValid = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);

        if (admin && isValid) {
          resolve({ success: true, adminId: admin.id, username: admin.username });
        } else {
          resolve({ success: false, error: LOGIN_FAILED });
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

// Admin registration function.
//
// The route that calls this refuses once any admin exists, so this is only
// ever reachable during first-run setup.
async function adminRegister(username, password) {
  return new Promise((resolve, reject) => {
    // Check if admin already exists
    dbHelpers.getAdminByUsername(username, (err, admin) => {
      if (err) {
        reject(err);
        return;
      }

      if (admin) {
        resolve({ success: false, error: 'Ийм нэртэй админ бүртгэлтэй байна.' });
        return;
      }

      // Hash password
      bcrypt.hash(password, 10, (hashError, hash) => {
        if (hashError) {
          reject(hashError);
          return;
        }

        // Create admin
        dbHelpers.createAdmin(username, hash, (createError, newAdmin) => {
          if (createError) {
            reject(createError);
          } else {
            resolve({ success: true, adminId: newAdmin.id, username: newAdmin.username });
          }
        });
      });
    });
  });
}

module.exports = {
  requireAdminAuth,
  adminLogin,
  adminRegister
};
