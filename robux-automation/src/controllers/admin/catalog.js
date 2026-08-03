// What is on sale — packages, loyalty levels and time-boxed bonus events.
const { ACTIONS, recordAdminAction } = require('../../services/audit');
const { parseThresholds } = require('../../services/levels');

module.exports = {
  async getLevels(req, res) {
    try {
      const setting = await new Promise((resolve, reject) => {
        this.dbHelpers.getSetting('level_thresholds', (error, row) => (error ? reject(error) : resolve(row)));
      });
      // Same tolerant read the pricing path uses, so an admin can still open
      // the levels editor and fix a bad value rather than being locked out of
      // the only screen that could repair it.
      res.json({ success: true, levels: parseThresholds(setting?.value) });
    } catch (error) {
      console.error('Get levels error:', error);
      res.status(500).json({ success: false, error: 'Түвшингийн мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  async updateLevels(req, res) {
    const levels = req.body.levels;
    if (!Array.isArray(levels) || !levels.length) {
      return res.status(400).json({ success: false, error: 'Хамгийн багадаа нэг түвшин оруулна уу.' });
    }

    const cleaned = [];
    for (const entry of levels) {
      const threshold = Number(entry?.threshold);
      const discountPercent = entry?.discountPercent === undefined ? 0 : Number(entry.discountPercent);
      if (!Number.isInteger(threshold) || threshold < 1) {
        return res.status(400).json({ success: false, error: 'Түвшин бүрийн босго эерэг бүхэл тоо байна.' });
      }
      if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 90) {
        return res.status(400).json({ success: false, error: 'Хямдрал 0-90% хооронд байна.' });
      }
      cleaned.push({ threshold, discountPercent });
    }
    cleaned.sort((a, b) => a.threshold - b.threshold);
    cleaned.forEach((entry, index) => { entry.level = index + 1; });

    try {
      await new Promise((resolve, reject) => {
        this.dbHelpers.setSetting('level_thresholds', JSON.stringify(cleaned), (error) => (error ? reject(error) : resolve()));
      });
      await recordAdminAction(this.dbHelpers, req, ACTIONS.SETTING_UPDATED, {
        entityType: 'setting', details: { setting: 'level_thresholds', levels: cleaned }
      });
      res.json({ success: true, message: 'Түвшингүүд хадгалагдлаа.', levels: cleaned });
    } catch (error) {
      console.error('Update levels error:', error);
      res.status(500).json({ success: false, error: 'Түвшин хадгалахад алдаа гарлаа.' });
    }
  },

  async getEvents(req, res) {
    try {
      const events = await new Promise((resolve, reject) => {
        this.dbHelpers.getEvents((error, rows) => (error ? reject(error) : resolve(rows)));
      });
      res.json({ success: true, events });
    } catch (error) {
      console.error('Get events error:', error);
      res.status(500).json({ success: false, error: 'Эвентийн мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  async createEvent(req, res) {
    const name = String(req.body.name || '').trim();
    const bonusPercent = Number(req.body.bonusPercent);
    const startsAt = String(req.body.startsAt || '').trim();
    const endsAt = String(req.body.endsAt || '').trim();

    if (!name) {
      return res.status(400).json({ success: false, error: 'Эвентийн нэрийг оруулна уу.' });
    }
    if (!Number.isFinite(bonusPercent) || bonusPercent <= 0 || bonusPercent > 500) {
      return res.status(400).json({ success: false, error: 'Бонус хувь 0-500 хооронд байна.' });
    }
    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
      return res.status(400).json({ success: false, error: 'Эхлэх, дуусах огноог зөв оруулна уу.' });
    }

    try {
      const event = await new Promise((resolve, reject) => {
        this.dbHelpers.createEvent(
          name, bonusPercent, startDate.toISOString(), endDate.toISOString(),
          (error, result) => (error ? reject(error) : resolve(result))
        );
      });
      await recordAdminAction(this.dbHelpers, req, ACTIONS.EVENT_CREATED, {
        entityType: 'event', entityId: event.id, details: { name, bonusPercent }
      });
      res.json({ success: true, message: 'Эвент үүслээ.', event });
    } catch (error) {
      console.error('Create event error:', error);
      res.status(500).json({ success: false, error: 'Эвент үүсгэхэд алдаа гарлаа.' });
    }
  },

  async deleteEvent(req, res) {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1) {
      return res.status(400).json({ success: false, error: 'Эвентийн ID буруу байна.' });
    }
    try {
      await new Promise((resolve, reject) => {
        this.dbHelpers.deleteEvent(eventId, (error, result) => (error ? reject(error) : resolve(result)));
      });
      await recordAdminAction(this.dbHelpers, req, ACTIONS.EVENT_DELETED, { entityType: 'event', entityId: eventId });
      res.json({ success: true, message: 'Эвент устгагдлаа.' });
    } catch (error) {
      console.error('Delete event error:', error);
      res.status(500).json({ success: false, error: 'Эвент устгахад алдаа гарлаа.' });
    }
  },

  async getEventStatus(req, res) {
    try {
      const event = await new Promise((resolve, reject) => {
        this.dbHelpers.getActiveEvent((error, row) => (error ? reject(error) : resolve(row)));
      });
      if (!event) return res.json({ success: true, active: false });
      res.json({
        success: true,
        active: true,
        name: event.name,
        bonusPercent: Number(event.bonus_percent),
        endsAt: event.ends_at
      });
    } catch (error) {
      console.error('Get event status error:', error);
      res.status(500).json({ success: false, error: 'Эвентийн төлөв авахад алдаа гарлаа.' });
    }
  },

  // Public feed for the Events tab. /event-status answers only "is a bonus
  // running right now?", which is all the header banner needs; a buyer
  // deciding when to top up also wants to see what is coming and which
  // packages are discounted today.
  async getPublicEvents(req, res) {
    try {
      const [events, packages] = await Promise.all([
        new Promise((resolve, reject) => {
          this.dbHelpers.getCurrentAndUpcomingEvents((error, rows) => (error ? reject(error) : resolve(rows)));
        }),
        new Promise((resolve, reject) => {
          this.dbHelpers.getPackages(true, (error, rows) => (error ? reject(error) : resolve(rows)));
        })
      ]);

      const now = Date.now();
      res.json({
        success: true,
        events: events.map((event) => ({
          id: event.id,
          name: event.name,
          bonusPercent: Number(event.bonus_percent),
          startsAt: event.starts_at,
          endsAt: event.ends_at,
          // Computed here rather than in the browser so the "live now" badge
          // agrees with the bonus the server will actually apply at checkout.
          live: new Date(event.starts_at).getTime() <= now
            && new Date(event.ends_at).getTime() >= now
        })),
        discountedPackages: packages
          .filter((pkg) => Number(pkg.discount_percent) > 0)
          .map((pkg) => ({
            id: pkg.id,
            robuxAmount: pkg.robux_amount,
            priceMnt: pkg.price_mnt,
            discountPercent: Number(pkg.discount_percent),
            effectivePriceMnt: Math.round(pkg.price_mnt * (1 - Number(pkg.discount_percent) / 100))
          }))
      });
    } catch (error) {
      console.error('Get public events error:', error);
      res.status(500).json({ success: false, error: 'Эвентийн мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  // Admin listing — every package, including inactive ones, raw fields.
  async getPackages(req, res) {
    try {
      const packages = await new Promise((resolve, reject) => {
        this.dbHelpers.getPackages(false, (error, rows) => (error ? reject(error) : resolve(rows)));
      });
      res.json({ success: true, packages });
    } catch (error) {
      console.error('Get packages error:', error);
      res.status(500).json({ success: false, error: 'Багцын мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  validatePackageInput(body) {
    const robuxAmount = Number(body.robuxAmount);
    const priceMnt = Number(body.priceMnt);
    const discountPercent = body.discountPercent === undefined ? 0 : Number(body.discountPercent);
    const sortOrder = body.sortOrder === undefined ? 0 : Number(body.sortOrder);
    const isActive = body.isActive === undefined ? true : Boolean(body.isActive);

    if (!Number.isInteger(robuxAmount) || robuxAmount < 1 || robuxAmount > 1000000) {
      return { error: 'Robux хэмжээ 1-1,000,000 хооронд бүхэл тоо байна.' };
    }
    if (!Number.isInteger(priceMnt) || priceMnt < 1) {
      return { error: 'Үнийг эерэг бүхэл тоогоор оруулна уу.' };
    }
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 90) {
      return { error: 'Хямдрал 0-90% хооронд байна.' };
    }
    return { robuxAmount, priceMnt, discountPercent, sortOrder, isActive };
  },

  async createPackage(req, res) {
    const parsed = this.validatePackageInput(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.createPackage(
          parsed.robuxAmount, parsed.priceMnt, parsed.discountPercent, parsed.sortOrder,
          (error, row) => (error ? reject(error) : resolve(row))
        );
      });
      await recordAdminAction(this.dbHelpers, req, ACTIONS.PACKAGE_CREATED, {
        entityType: 'package', entityId: result.id, details: parsed
      });
      res.json({ success: true, message: 'Багц үүслээ.', id: result.id });
    } catch (error) {
      console.error('Create package error:', error);
      res.status(500).json({ success: false, error: 'Багц үүсгэхэд алдаа гарлаа.' });
    }
  },

  async updatePackage(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Багцын ID буруу байна.' });
    }
    const parsed = this.validatePackageInput(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.updatePackage(
          id, parsed.robuxAmount, parsed.priceMnt, parsed.discountPercent, parsed.isActive, parsed.sortOrder,
          (error, row) => (error ? reject(error) : resolve(row))
        );
      });
      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Багц олдсонгүй.' });
      }
      await recordAdminAction(this.dbHelpers, req, ACTIONS.PACKAGE_UPDATED, {
        entityType: 'package', entityId: id, details: parsed
      });
      res.json({ success: true, message: 'Багц шинэчлэгдлээ.' });
    } catch (error) {
      console.error('Update package error:', error);
      res.status(500).json({ success: false, error: 'Багц шинэчлэхэд алдаа гарлаа.' });
    }
  },

  async deletePackage(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Багцын ID буруу байна.' });
    }
    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.deletePackage(id, (error, row) => (error ? reject(error) : resolve(row)));
      });
      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Багц олдсонгүй.' });
      }
      await recordAdminAction(this.dbHelpers, req, ACTIONS.PACKAGE_DELETED, { entityType: 'package', entityId: id });
      res.json({ success: true, message: 'Багц устгагдлаа.' });
    } catch (error) {
      console.error('Delete package error:', error);
      res.status(500).json({ success: false, error: 'Багц устгахад алдаа гарлаа.' });
    }
  },

  // Public storefront listing — active packages only, with the manual
  // discount already applied to a display price. The buyer's own level
  // discount is layered on top client-side (from /profile) as a preview;
  // the real price is always recomputed server-side at order creation.
  async getPublicPackages(req, res) {
    try {
      const packages = await new Promise((resolve, reject) => {
        this.dbHelpers.getPackages(true, (error, rows) => (error ? reject(error) : resolve(rows)));
      });
      res.json({
        success: true,
        packages: packages.map((pkg) => ({
          id: pkg.id,
          robuxAmount: pkg.robux_amount,
          priceMnt: pkg.price_mnt,
          discountPercent: Number(pkg.discount_percent) || 0,
          effectivePriceMnt: Math.round(pkg.price_mnt * (1 - (Number(pkg.discount_percent) || 0) / 100))
        }))
      });
    } catch (error) {
      console.error('Get public packages error:', error);
      res.status(500).json({ success: false, error: 'Багцын мэдээлэл авахад алдаа гарлаа.' });
    }
  }
};
