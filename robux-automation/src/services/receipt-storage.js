// Where uploaded payment receipts actually live.
//
// Receipts are private financial documents. Two properties have to survive
// any change of backend:
//
//   1. They are never reachable without going through the admin-authenticated
//      serve() route in receipt-controller.js.
//   2. The stored name is derived from the file's SHA-256, never from the
//      browser-supplied filename.
//
// The controller used to call fs.writeFile / fs.createReadStream directly
// against uploads/receipts. That cannot work on Vercel: a serverless
// function's filesystem is per-invocation, so a receipt written while
// answering one request is gone by the next — an admin reviewing a payment
// would find every file missing.
//
// Two backends, chosen by environment:
//
//   BLOB_READ_WRITE_TOKEN set -> Vercel Blob, with access: 'private'. Private
//                                is not a detail: a public blob is readable
//                                by anyone holding the URL, which would put
//                                customers' bank documents outside the admin
//                                gate entirely.
//   otherwise                 -> the local uploads/receipts directory, so
//                                development and tests behave as before.

const fs = require('fs');
const path = require('path');

const RECEIPT_DIR = path.join(__dirname, '../../uploads/receipts');

// Namespaced so the store can hold other things later without collision.
const BLOB_PREFIX = 'receipts/';

const usingBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

// ---------------------------------------------------------------------------
// Local disk
// ---------------------------------------------------------------------------

function resolveLocal(storedName) {
  // stored_name is always a hash plus a known extension, but resolve and
  // re-check the prefix anyway so a tampered database row cannot escape the
  // directory.
  const filePath = path.resolve(RECEIPT_DIR, storedName);
  if (!filePath.startsWith(path.resolve(RECEIPT_DIR) + path.sep)) {
    throw Object.assign(new Error('Receipt path escapes the receipt directory'), {
      code: 'RECEIPT_PATH_INVALID'
    });
  }
  return filePath;
}

const localStorage = {
  async save(storedName, buffer) {
    await fs.promises.mkdir(RECEIPT_DIR, { recursive: true });
    await fs.promises.writeFile(resolveLocal(storedName), buffer);
  },

  async openStream(storedName) {
    const filePath = resolveLocal(storedName);
    if (!fs.existsSync(filePath)) return null;
    return fs.createReadStream(filePath);
  }
};

// ---------------------------------------------------------------------------
// Vercel Blob
// ---------------------------------------------------------------------------

const blobStorage = {
  async save(storedName, buffer, contentType) {
    const { put } = require('@vercel/blob');
    await put(BLOB_PREFIX + storedName, buffer, {
      access: 'private',
      contentType,
      // The name is already a content hash, so a random suffix would only
      // make the same bytes unfindable by the name the database recorded.
      addRandomSuffix: false,
      // Re-uploading identical bytes is a no-op rather than an error. The
      // caller reaches this only after the sha256 lookup missed, which a
      // concurrent upload of the same file can still race.
      allowOverwrite: true
    });
  },

  async openStream(storedName) {
    const { get } = require('@vercel/blob');
    // Guard the same way the local backend does — a stored_name containing a
    // traversal segment must not become a different blob path.
    if (storedName.includes('/') || storedName.includes('\\') || storedName.includes('..')) {
      throw Object.assign(new Error('Receipt name is not a bare filename'), {
        code: 'RECEIPT_PATH_INVALID'
      });
    }

    const result = await get(BLOB_PREFIX + storedName, { access: 'private' });
    return result ? result.stream : null;
  }
};

const backend = usingBlob ? blobStorage : localStorage;

module.exports = {
  /**
   * Writes the receipt bytes under `storedName` (a sha256 plus extension).
   */
  save: (storedName, buffer, contentType) => backend.save(storedName, buffer, contentType),

  /**
   * A readable stream of the stored receipt, or null if it is not there.
   * Throws with code RECEIPT_PATH_INVALID if the name is not a bare filename.
   */
  openStream: (storedName) => backend.openStream(storedName),

  RECEIPT_DIR,
  usingBlob
};
