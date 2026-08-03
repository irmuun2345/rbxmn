const crypto = require('crypto');

// Ambiguous glyphs removed: a reference code gets hand-typed into a bank
// transfer description, and 0/O or 1/I mix-ups there cost an admin a manual
// reconciliation.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 8;

// crypto.randomInt rather than Math.random: these codes are the only thing
// tying a bank transfer to an order, so they shouldn't be guessable from one
// another.
function randomSuffix(length) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return code;
}

function referenceExists(dbHelpers, reference) {
  return new Promise((resolve, reject) => {
    dbHelpers.isPaymentReferenceTaken(reference, (error, taken) => (
      error ? reject(error) : resolve(taken)
    ));
  });
}

// Generates a code that is not already in use by an order or a gift card.
// The DB also carries a unique index, so this loop is the friendly path and
// the index is the guarantee — if both somehow disagree the INSERT fails
// loudly rather than quietly attaching one payment to two top-ups.
async function generateUniqueReference(dbHelpers, prefix = 'RBX') {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Widen the code after a few collisions rather than spinning at a length
    // that has clearly become crowded.
    const length = CODE_LENGTH + Math.floor(attempt / 3);
    const candidate = `${prefix}-${randomSuffix(length)}`;
    if (!(await referenceExists(dbHelpers, candidate))) {
      return candidate;
    }
  }

  throw Object.assign(
    new Error('Төлбөрийн код үүсгэж чадсангүй. Дахин оролдоно уу.'),
    { code: 'REFERENCE_GENERATION_FAILED' }
  );
}

module.exports = { generateUniqueReference, randomSuffix, ALPHABET };
