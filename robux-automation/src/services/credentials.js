// Encryption at rest for the two secrets this system stores on the bot's
// behalf: its .ROBLOSECURITY cookie and its authenticator seed.
//
// What this protects against, precisely: a leaked database file. A copied
// robux.db, a backup on someone's laptop, a disk pulled from a dead server.
// Those are the realistic ways a small deployment loses its data, and none of
// them come with the key.
//
// What it does NOT protect against: a compromised running process. The key is
// in this process's environment because the process has to decrypt the cookie
// to use it. Anyone who can execute code here can read both. That is inherent
// in a server that acts as the bot, not a shortcoming of this file.
//
// Values are self-describing — `v1:<iv>:<tag>:<ciphertext>`, all base64url —
// so a stored value can always be told apart from a plaintext one. That is
// what lets an existing install keep working after this was introduced: rows
// written before it read back as-is, and get encrypted the next time they are
// saved.

const crypto = require('crypto');

const PREFIX = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

const isProduction = process.env.NODE_ENV === 'production';

// Read lazily rather than at require time: tests and setup scripts pull this
// module in without ever encrypting anything, and config/.env is loaded by
// app.js, which may not have run yet.
let cachedKey;
let warnedAboutMissingKey = false;

function readKey() {
  if (cachedKey !== undefined) return cachedKey;

  const raw = process.env.CREDENTIAL_KEY;
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }

  // base64url, base64 and hex all decode through Buffer; the length check is
  // what actually distinguishes a real key from a typo.
  const key = Buffer.from(raw, /^[0-9a-fA-F]{64}$/.test(raw) ? 'hex' : 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. `
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
    );
  }

  cachedKey = key;
  return cachedKey;
}

// Called once at boot. Production refuses to start without a key rather than
// silently storing session cookies in the clear — the same rule, and for the
// same reason, as SESSION_SECRET.
function assertCredentialKey() {
  const key = readKey();
  if (key) return true;

  if (isProduction) {
    console.error(
      'FATAL: CREDENTIAL_KEY is not set. The bot cookie and 2FA secret would be '
      + 'stored in plaintext. Generate one with:\n'
      + "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
    );
    process.exit(1);
  }

  console.warn(
    'WARNING: CREDENTIAL_KEY is unset — bot credentials will be stored in plaintext (development only).'
  );
  return false;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

/**
 * Encrypts a secret for storage. Without a key configured the value is
 * returned unchanged, which is what keeps development working — and why
 * assertCredentialKey() exists to make sure that never happens in production.
 */
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;

  const key = readKey();
  if (!key) {
    if (!warnedAboutMissingKey) {
      console.warn('Storing a credential without CREDENTIAL_KEY set — value is in plaintext.');
      warnedAboutMissingKey = true;
    }
    return String(plaintext);
  }

  // Already sealed. Re-encrypting would nest the envelope and the value would
  // decrypt to a ciphertext string.
  if (isEncrypted(plaintext)) return plaintext;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return [
    PREFIX,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url')
  ].join(':');
}

/**
 * Reverses encryptSecret. A value with no envelope is returned as-is: those
 * are rows written before this module existed, and refusing to read them would
 * take every existing install offline at the moment of upgrade.
 *
 * A value that *is* enveloped but fails to decrypt throws. That means the key
 * changed or the row was tampered with, and quietly handing back a broken
 * cookie would surface as an unexplained delivery outage hours later.
 */
function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === '') return stored;
  if (!isEncrypted(stored)) return String(stored);

  const key = readKey();
  if (!key) {
    throw Object.assign(
      new Error('CREDENTIAL_KEY is not set, but a stored credential is encrypted with one.'),
      { code: 'CREDENTIAL_DECRYPT_FAILED' }
    );
  }

  const [, iv, tag, ciphertext] = String(stored).split(':');
  if (!iv || !tag || !ciphertext) {
    throw Object.assign(
      new Error('Stored credential is malformed.'),
      { code: 'CREDENTIAL_DECRYPT_FAILED' }
    );
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    // The GCM tag failing is the whole point of using GCM — it means this is
    // not the key that wrote the value, or the row was edited underneath us.
    throw Object.assign(
      new Error(
        'Stored credential could not be decrypted. CREDENTIAL_KEY may have changed — '
        + 'reconnect the bot account in the dashboard to store it again.'
      ),
      { code: 'CREDENTIAL_DECRYPT_FAILED' }
    );
  }
}

module.exports = {
  assertCredentialKey,
  encryptSecret,
  decryptSecret,
  isEncrypted,
  // Tests need a way to pick up a key set after this module was first loaded.
  resetKeyCache: () => { cachedKey = undefined; warnedAboutMissingKey = false; }
};
