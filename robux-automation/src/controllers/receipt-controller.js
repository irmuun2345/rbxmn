const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { ORDER_STATUS } = require('../services/order-status');
const orders = require('../services/orders');
const { ACTIONS, recordUserAction, recordAdminAction } = require('../services/audit');

// Receipts are private financial documents. They live outside public/ so that
// express.static can never hand one out, and are only readable through the
// admin-authenticated serve() route below.
const RECEIPT_DIR = path.join(__dirname, '../../uploads/receipts');
const MAX_BYTES = 5 * 1024 * 1024;

// Photos of a bank transfer, plus PDF for people who export the statement.
const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf'
};

// What each accepted format actually starts with on disk.
//
// This exists because multer's `file.mimetype` is not a fact about the file —
// it is the Content-Type the *client* wrote on the multipart part, and a
// client can write anything there. Trusting it meant the allowlist check, the
// stored file's extension, and the Content-Type the admin route later served
// back were all chosen by the uploader. Someone could store arbitrary bytes
// as `.png` and have this server hand them back labelled `image/png`.
//
// The response headers on serve() (nosniff plus a locked-down CSP) already
// stopped that becoming stored XSS, but "the browser refuses to run it" is a
// second line of defence, not a reason to accept the file in the first place.
const MAGIC_BYTES = [
  { mime: 'image/jpeg', extension: '.jpg', signature: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', extension: '.png', signature: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'application/pdf', extension: '.pdf', signature: [0x25, 0x50, 0x44, 0x46, 0x2D] }, // %PDF-
  // WEBP is RIFF....WEBP — the 4 size bytes in between are per-file, so the
  // two fixed runs are checked at their own offsets.
  {
    mime: 'image/webp',
    extension: '.webp',
    signature: [0x52, 0x49, 0x46, 0x46], // RIFF
    also: { offset: 8, signature: [0x57, 0x45, 0x42, 0x50] } // WEBP
  }
];

function startsWith(buffer, signature, offset = 0) {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

// Returns the real type of the bytes, or null if they aren't one we accept.
// The client's claimed mimetype is deliberately not consulted.
function detectType(buffer) {
  return MAGIC_BYTES.find((candidate) => (
    startsWith(buffer, candidate.signature)
    && (!candidate.also || startsWith(buffer, candidate.also.signature, candidate.also.offset))
  )) || null;
}

fs.mkdirSync(RECEIPT_DIR, { recursive: true });

// Buffered in memory rather than streamed to disk: the file has to be hashed
// and checked for a duplicate *before* anything is written, otherwise a
// rejected re-upload still litters the disk. 5 MB is a safe ceiling to hold.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!ALLOWED_MIME[file.mimetype]) {
      return callback(Object.assign(
        new Error('Зөвхөн JPG, PNG, WEBP зураг эсвэл PDF хүлээн авна.'),
        { code: 'UNSUPPORTED_RECEIPT_TYPE' }
      ));
    }
    callback(null, true);
  }
});

// Wraps multer so its errors come back as normal JSON instead of an HTML
// stack trace from the default express handler.
function receiptUpload(req, res, next) {
  upload.single('receipt')(req, res, (error) => {
    if (!error) return next();

    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Баримтын хэмжээ 5MB-аас хэтэрсэн байна.'
      : error.code === 'UNSUPPORTED_RECEIPT_TYPE'
        ? error.message
        : 'Баримтыг хүлээн авч чадсангүй.';
    res.status(400).json({ success: false, error: message });
  });
}

class ReceiptController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  findExistingBySha(sha256) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getReceiptBySha256(sha256, (error, row) => (error ? reject(error) : resolve(row)));
    });
  }

  insert(receipt) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.createReceipt(receipt, (error, row) => (error ? reject(error) : resolve(row)));
    });
  }

  // POST /orders/:id/receipt
  async submitForOrder(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Төлбөрийн баримтаа хавсаргана уу.' });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }
      // Ownership check before anything else: an order ID is a small integer,
      // so without this any logged-in user could attach a receipt to someone
      // else's order.
      if (order.user_id !== req.session.userId) {
        return res.status(403).json({ success: false, error: 'Энэ захиалга танийх биш байна.' });
      }
      if (![ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_REJECTED].includes(order.status)) {
        return res.status(409).json({
          success: false,
          error: 'Энэ захиалга баримт хүлээн авах төлөвт биш байна.'
        });
      }

      const stored = await this.storeReceipt(req.file, 'order', orderId, req.session.userId);
      if (stored.duplicate) {
        // A blocked reuse is worth a permanent record — it's the signature of
        // someone trying to get two top-ups out of one bank transfer.
        await recordUserAction(this.dbHelpers, req, ACTIONS.RECEIPT_DUPLICATE_BLOCKED, {
          entityType: 'order',
          entityId: orderId,
          details: {
            originallyUsedOn: stored.existing
              ? { entityType: stored.existing.entity_type, entityId: stored.existing.entity_id }
              : null
          }
        });
        return res.status(409).json({
          success: false,
          error: 'Энэ баримт өмнө нь ашиглагдсан байна. Тухайн шилжүүлгийн жинхэнэ баримтаа илгээнэ үү.'
        });
      }

      await recordUserAction(this.dbHelpers, req, ACTIONS.RECEIPT_SUBMITTED, {
        entityType: 'order',
        entityId: orderId,
        details: {
          receiptId: stored.receipt.id,
          mimeType: req.file.mimetype,
          byteSize: req.file.size,
          resubmission: order.status === ORDER_STATUS.PAYMENT_REJECTED
        }
      });

      const moved = await orders.markPaymentSubmitted(this.dbHelpers, orderId);
      if (!moved) {
        return res.status(409).json({ success: false, error: 'Захиалгын төлөв өөрчлөгдсөн байна. Хуудсаа сэргээнэ үү.' });
      }

      res.json({
        success: true,
        message: 'Баримт хүлээн авлаа. Админ шалгасны дараа Robux хүргэгдэнэ.',
        receiptId: stored.receipt.id,
        status: ORDER_STATUS.PAYMENT_SUBMITTED
      });
    } catch (error) {
      // A content/extension mismatch is the uploader's problem, not ours —
      // answer 400 with something actionable rather than a blanket 500.
      if (error.code === 'RECEIPT_CONTENT_MISMATCH') {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Submit receipt error:', error);
      res.status(500).json({ success: false, error: 'Баримтыг хадгалж чадсангүй. Дахин оролдоно уу.' });
    }
  }

  // POST /gift-cards/:id/receipt — same rules, different entity.
  async submitForGiftCard(req, res) {
    const giftCardId = Number(req.params.id);
    if (!Number.isInteger(giftCardId) || giftCardId < 1) {
      return res.status(400).json({ success: false, error: 'Бэлгийн картын ID буруу байна.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Төлбөрийн баримтаа хавсаргана уу.' });
    }

    try {
      const card = await new Promise((resolve, reject) => {
        this.dbHelpers.getGiftCardById(giftCardId, (error, row) => (error ? reject(error) : resolve(row)));
      });
      if (!card) {
        return res.status(404).json({ success: false, error: 'Бэлгийн карт олдсонгүй.' });
      }
      if (card.purchaser_user_id !== req.session.userId) {
        return res.status(403).json({ success: false, error: 'Энэ бэлгийн карт танийх биш байна.' });
      }
      if (card.status !== 'awaiting_payment') {
        return res.status(409).json({ success: false, error: 'Энэ карт баримт хүлээн авах төлөвт биш байна.' });
      }

      const stored = await this.storeReceipt(req.file, 'gift_card', giftCardId, req.session.userId);
      if (stored.duplicate) {
        return res.status(409).json({
          success: false,
          error: 'Энэ баримт өмнө нь ашиглагдсан байна. Тухайн шилжүүлгийн жинхэнэ баримтаа илгээнэ үү.'
        });
      }

      res.json({
        success: true,
        message: 'Баримт хүлээн авлаа. Админ шалгасны дараа код идэвхжинэ.',
        receiptId: stored.receipt.id
      });
    } catch (error) {
      if (error.code === 'RECEIPT_CONTENT_MISMATCH') {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Submit gift card receipt error:', error);
      res.status(500).json({ success: false, error: 'Баримтыг хадгалж чадсангүй. Дахин оролдоно уу.' });
    }
  }

  // Hash first, write second. The UNIQUE index on sha256 is the real
  // guarantee — the pre-check just turns the common case into a friendly
  // message instead of a constraint error.
  async storeReceipt(file, entityType, entityId, userId) {
    // The bytes decide what this is — not the Content-Type the uploader
    // wrote on the part. Everything downstream (the extension on disk, the
    // mime recorded in the row, the Content-Type serve() sends back) is
    // derived from this result, so a lie in the multipart header changes
    // nothing about how the file is stored or returned.
    const detected = detectType(file.buffer);
    if (!detected) {
      throw Object.assign(
        new Error('Баримтын агуулга зөвшөөрөгдсөн зураг эсвэл PDF биш байна.'),
        { code: 'RECEIPT_CONTENT_MISMATCH' }
      );
    }

    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

    const existing = await this.findExistingBySha(sha256);
    if (existing) {
      return { duplicate: true, existing };
    }

    const storedName = `${sha256}${detected.extension}`;
    await fs.promises.writeFile(path.join(RECEIPT_DIR, storedName), file.buffer);

    try {
      const receipt = await this.insert({
        entityType,
        entityId,
        userId,
        storedName,
        // The browser-supplied filename is display-only and never touches the
        // filesystem — the stored name is derived from the hash.
        originalName: String(file.originalname || '').slice(0, 200),
        mimeType: detected.mime,
        byteSize: file.size,
        sha256
      });
      return { duplicate: false, receipt };
    } catch (error) {
      // Lost a race against a concurrent upload of the same bytes. The file
      // on disk is identical, so leaving it is harmless and correct.
      if (String(error.message || '').includes('UNIQUE')) {
        return { duplicate: true, existing: await this.findExistingBySha(sha256) };
      }
      throw error;
    }
  }

  // GET /admin/receipts/:id — admin-only, streams from outside the web root.
  async serve(req, res) {
    const receiptId = Number(req.params.id);
    if (!Number.isInteger(receiptId) || receiptId < 1) {
      return res.status(400).json({ success: false, error: 'Баримтын ID буруу байна.' });
    }

    try {
      const receipt = await new Promise((resolve, reject) => {
        this.dbHelpers.getReceiptById(receiptId, (error, row) => (error ? reject(error) : resolve(row)));
      });
      if (!receipt) {
        return res.status(404).json({ success: false, error: 'Баримт олдсонгүй.' });
      }

      // stored_name is always a hash + known extension, but resolve and
      // re-check the prefix anyway so a tampered row can't escape the
      // directory.
      const filePath = path.resolve(RECEIPT_DIR, receipt.stored_name);
      if (!filePath.startsWith(path.resolve(RECEIPT_DIR) + path.sep)) {
        return res.status(400).json({ success: false, error: 'Баримтын зам буруу байна.' });
      }
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Баримтын файл олдсонгүй.' });
      }

      // Who looked at which financial document, and when.
      await recordAdminAction(this.dbHelpers, req, ACTIONS.RECEIPT_VIEWED, {
        entityType: receipt.entity_type,
        entityId: receipt.entity_id,
        details: { receiptId: receipt.id }
      });

      // Rows written before uploads were content-checked carry whatever mime
      // the uploader claimed, so the stored value is never echoed blindly —
      // anything not on the allowlist is served as an opaque download.
      res.type(ALLOWED_MIME[receipt.mime_type] ? receipt.mime_type : 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-store');
      // Financial documents shouldn't be embeddable anywhere else.
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      console.error('Serve receipt error:', error);
      res.status(500).json({ success: false, error: 'Баримтыг нээж чадсангүй.' });
    }
  }

  // GET /admin/receipts/:entityType/:entityId — the review list for one order.
  async listForEntity(req, res) {
    const entityType = req.params.entityType === 'gift_card' ? 'gift_card' : 'order';
    const entityId = Number(req.params.entityId);
    if (!Number.isInteger(entityId) || entityId < 1) {
      return res.status(400).json({ success: false, error: 'ID буруу байна.' });
    }

    try {
      const receipts = await new Promise((resolve, reject) => {
        this.dbHelpers.getReceiptsForEntity(entityType, entityId, (error, rows) => (
          error ? reject(error) : resolve(rows)
        ));
      });
      res.json({
        success: true,
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          originalName: receipt.original_name,
          mimeType: receipt.mime_type,
          byteSize: receipt.byte_size,
          uploadedAt: receipt.uploaded_at,
          url: `/admin/receipts/${receipt.id}`
        }))
      });
    } catch (error) {
      console.error('List receipts error:', error);
      res.status(500).json({ success: false, error: 'Баримтуудыг авч чадсангүй.' });
    }
  }
}

module.exports = { ReceiptController, receiptUpload, RECEIPT_DIR, MAX_BYTES };
