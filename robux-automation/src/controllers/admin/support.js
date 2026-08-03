// Read-mostly views used to answer a customer question: the audit trail, phone links
// and gift cards.
const { ACTIONS, recordAdminAction } = require('../../services/audit');

// Audit details are written by this app, so malformed JSON means something is
// already wrong — which is exactly when the log has to stay readable. The raw
// string is surfaced rather than dropped, because an entry you can't parse is
// still evidence.
function safeParseDetails(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { unparsed: String(raw).slice(0, 500) };
  }
}

module.exports = {
  // GET /admin/audit-log — read-only view of the append-only trail.
  async getAuditLog(req, res) {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    try {
      const [entries, total] = await Promise.all([
        new Promise((resolve, reject) => {
          this.dbHelpers.getAuditLog({
            action: req.query.action || null,
            actorType: req.query.actorType || null,
            entityType: req.query.entityType || null,
            entityId: req.query.entityId ? Number(req.query.entityId) : null,
            limit,
            offset
          }, (error, rows) => (error ? reject(error) : resolve(rows)));
        }),
        new Promise((resolve, reject) => {
          this.dbHelpers.getAuditLogCount((error, count) => (error ? reject(error) : resolve(count)));
        })
      ]);

      res.json({
        success: true,
        total,
        limit,
        offset,
        entries: entries.map((entry) => ({
          id: entry.id,
          actorType: entry.actor_type,
          actorName: entry.actor_name,
          action: entry.action,
          entityType: entry.entity_type,
          entityId: entry.entity_id,
          // Stored as JSON text; a malformed row shouldn't break the view.
          // It previously did — the throw landed in the outer catch and 500'd
          // the entire log, which is precisely the moment you least want the
          // audit trail unreadable. The raw text is passed through instead so
          // the entry is still legible.
          details: safeParseDetails(entry.details),
          ipAddress: entry.ip_address,
          createdAt: entry.created_at
        }))
      });
    } catch (error) {
      console.error('Get audit log error:', error);
      res.status(500).json({ success: false, error: 'Аудит бүртгэлийг авч чадсангүй.' });
    }
  },

  async getPhoneLinks(req, res) {
    try {
      const links = await new Promise((resolve, reject) => {
        this.dbHelpers.getAllPhoneLinks((error, rows) => (error ? reject(error) : resolve(rows)));
      });
      res.json({ success: true, links });
    } catch (error) {
      console.error('Get phone links error:', error);
      res.status(500).json({ success: false, error: 'Утасны холболтуудыг авч чадсангүй.' });
    }
  },

  async unlinkPhone(req, res) {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ success: false, error: 'Хэрэглэгчийн ID буруу байна.' });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.unlinkPhoneByUserId(userId, (error, update) => (error ? reject(error) : resolve(update)));
      });
      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Утасны холболт олдсонгүй.' });
      }
      await recordAdminAction(this.dbHelpers, req, ACTIONS.PHONE_UNLINKED, { entityType: 'user', entityId: userId });
      res.json({ success: true, message: 'Утасны холболт салгагдлаа. Хэрэглэгч дахин холбох боломжтой.' });
    } catch (error) {
      console.error('Unlink phone error:', error);
      res.status(500).json({ success: false, error: 'Утасны холболтыг салгаж чадсангүй.' });
    }
  },

  async getGiftCards(req, res) {
    try {
      const giftCards = await new Promise((resolve, reject) => {
        this.dbHelpers.getGiftCards((error, rows) => (error ? reject(error) : resolve(rows)));
      });
      res.json({ success: true, giftCards });
    } catch (error) {
      console.error('Get gift cards error:', error);
      res.status(500).json({ success: false, error: 'Бэлгийн картуудыг авч чадсангүй.' });
    }
  },

  async approveGiftCard(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Бэлгийн картын ID буруу байна.' });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.markGiftCardPaymentReceived(id, (error, update) => (error ? reject(error) : resolve(update)));
      });
      if (!result.changes) {
        return res.status(404).json({
          success: false,
          error: 'Төлбөр хүлээж буй бэлгийн карт олдсонгүй.'
        });
      }
      await recordAdminAction(this.dbHelpers, req, ACTIONS.GIFT_CARD_APPROVED, {
        entityType: 'gift_card',
        entityId: id
      });

      res.json({ success: true, message: 'Бэлгийн картыг баталгаажууллаа. Одоо ашиглах боломжтой.' });
    } catch (error) {
      console.error('Approve gift card error:', error);
      res.status(500).json({ success: false, error: 'Бэлгийн картыг баталгаажуулж чадсангүй.' });
    }
  },

  // Rejecting a gift card's payment. Gift cards have no partial states, so
  // this simply returns the card to awaiting_payment with the reason attached.
  async rejectGiftCard(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Бэлгийн картын ID буруу байна.' });
    }

    const reason = String(req.body.reason || '').trim();
    if (reason.length < 4 || reason.length > 300) {
      return res.status(400).json({
        success: false,
        error: 'Татгалзсан шалтгааныг 4-300 тэмдэгтээр бичнэ үү.'
      });
    }

    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.rejectGiftCardPayment(id, reason, (error, update) => (
          error ? reject(error) : resolve(update)
        ));
      });
      if (!result.changes) {
        return res.status(409).json({
          success: false,
          error: 'Татгалзах боломжтой бэлгийн карт олдсонгүй.'
        });
      }
      await recordAdminAction(this.dbHelpers, req, ACTIONS.GIFT_CARD_REJECTED, {
        entityType: 'gift_card',
        entityId: id,
        details: { reason }
      });

      res.json({ success: true, message: 'Бэлгийн картын төлбөрийг татгалзлаа.' });
    } catch (error) {
      console.error('Reject gift card error:', error);
      res.status(500).json({ success: false, error: 'Татгалзах үйлдэл амжилтгүй боллоо.' });
    }
  }
};
