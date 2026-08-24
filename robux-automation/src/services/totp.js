// The six-digit authenticator code, generated here rather than typed by a
// human.
//
// Payouts are sent by a poller that wakes every 90 seconds at any hour. When
// Roblox raises a 2-step verification challenge there is nobody to ask for a
// code, so the alternative to this file is delivery stopping until morning.
//
// RFC 6238 (TOTP) over RFC 4226 (HOTP): HMAC-SHA1 of the 30-second counter,
// dynamically truncated to six digits. Forty lines and no dependency, which is
// why it is written out rather than pulled in.

const crypto = require('crypto');

const DIGITS = 6;
const STEP_SECONDS = 30;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function invalidSecret(message) {
  return Object.assign(new Error(message), { code: 'INVALID_TOTP_SECRET' });
}

// Authenticator seeds are shown to humans in groups of four with padding, and
// get pasted back with both. Neither is part of the value.
function decodeBase32(secret) {
  const cleaned = String(secret || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '');

  if (!cleaned) throw invalidSecret('2FA секрет хоосон байна.');
  if (/[^A-Z2-7]/.test(cleaned)) {
    throw invalidSecret('2FA секрет буруу байна. Authenticator-аас өгсөн base32 түлхүүрийг оруулна уу.');
  }

  const bytes = [];
  let buffer = 0;
  let bitsHeld = 0;

  for (const character of cleaned) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bitsHeld += 5;
    if (bitsHeld >= 8) {
      bitsHeld -= 8;
      bytes.push((buffer >>> bitsHeld) & 0xff);
    }
  }

  // Fewer than 80 bits is not a real authenticator seed — it is a typo or a
  // truncated paste, and it would happily produce plausible-looking codes that
  // Roblox rejects every single time.
  if (bytes.length < 10) {
    throw invalidSecret('2FA секрет хэтэрхий богино байна. Бүтэн түлхүүрээ хуулж оруулна уу.');
  }

  return Buffer.from(bytes);
}

function counterBuffer(counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
}

/**
 * The code valid at `at` (default: now).
 *
 * `offsetSteps` shifts by whole 30-second windows. Roblox accepts a small
 * amount of clock drift, and if a server's clock is off the retry is the only
 * thing standing between that and every payout failing — see roblox-group.js.
 */
function generateTotp(secret, { at = Date.now(), offsetSteps = 0, digits = DIGITS } = {}) {
  const key = decodeBase32(secret);
  const counter = Math.floor(at / 1000 / STEP_SECONDS) + offsetSteps;

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer(counter)).digest();

  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks
  // where to read the four-byte value from.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];

  return String(binary % 10 ** digits).padStart(digits, '0');
}

// Used by the dashboard to reject a bad secret while the admin is still
// looking at the form, rather than at 3am when a payout needs it.
function isValidTotpSecret(secret) {
  try {
    decodeBase32(secret);
    return true;
  } catch {
    return false;
  }
}

module.exports = { generateTotp, isValidTotpSecret, STEP_SECONDS };
