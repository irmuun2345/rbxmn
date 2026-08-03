const referrals = require('../services/referrals');
const { ACTIONS, recordUserAction, recordAdminAction } = require('../services/audit');

// Every failure mode in the service carries a machine-readable code; mapping
// them here means the HTTP status reflects what actually went wrong instead
// of collapsing "you already have a code" and "the database is down" into the
// same 500.
const ERROR_STATUS = {
  CODE_REQUIRED: 400,
  CODE_LENGTH: 400,
  CODE_CHARSET: 400,
  CODE_RESERVED: 400,
  CODE_TAKEN: 409,
  CODE_NOT_FOUND: 404,
  CODE_INACTIVE: 409,
  ALREADY_HAS_CODE: 409,
  ALREADY_REFERRED: 409,
  SELF_REFERRAL: 403,
  NOT_NEW_CUSTOMER: 403,
  REFERRALS_DISABLED: 503
};

function promisify(dbHelpers, method, ...args) {
  return new Promise((resolve, reject) => {
    dbHelpers[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

class ReferralController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  respondWithError(res, error, fallback) {
    const status = ERROR_STATUS[error.code];
    if (status) {
      return res.status(status).json({ success: false, error: error.message, code: error.code });
    }
    console.error(`${fallback}:`, error);
    return res.status(500).json({ success: false, error: fallback });
  }

  // GET /referral/me — the user's own code, their earnings, and who referred
  // them. One call, because the storefront panel needs all three at once.
  async getMine(req, res) {
    try {
      const [settings, code, attribution] = await Promise.all([
        referrals.getReferralSettings(this.dbHelpers),
        promisify(this.dbHelpers, 'getReferralCodeByUserId', req.session.userId),
        promisify(this.dbHelpers, 'getReferralAttribution', req.session.userId)
      ]);

      const stats = code ? await promisify(this.dbHelpers, 'getReferralStats', code.id) : null;

      res.json({
        success: true,
        enabled: settings.enabled,
        minCodeLength: referrals.CODE_MIN_LENGTH,
        maxCodeLength: referrals.CODE_MAX_LENGTH,
        // What a new customer would get for using someone's code — shown so
        // a creator knows what they're offering their audience.
        bonusPercent: settings.bonusPercent,
        commissionPercent: settings.commissionPercent,
        minPayoutRobux: settings.minPayoutRobux,
        myCode: code ? {
          code: code.code,
          isInfluencer: Boolean(code.is_influencer),
          isActive: Boolean(code.is_active),
          createdAt: code.created_at,
          // An override means this creator has negotiated terms; show theirs.
          bonusPercent: code.bonus_percent_override ?? settings.bonusPercent,
          commissionPercent: code.commission_percent_override ?? settings.commissionPercent,
          stats
        } : null,
        referredBy: attribution ? {
          code: attribution.code,
          username: attribution.referrer_username,
          boundAt: attribution.bound_at
        } : null
      });
    } catch (error) {
      console.error('Get referral info error:', error);
      res.status(500).json({ success: false, error: 'Урилгын мэдээллийг авч чадсангүй.' });
    }
  }

  // GET /referral/available/:code — live "is this taken?" for the create form.
  // Advisory only; the UNIQUE index is the real arbiter at claim time.
  async checkAvailability(req, res) {
    try {
      const result = await referrals.isCodeAvailable(this.dbHelpers, req.params.code);
      res.json({ success: true, ...result });
    } catch (error) {
      if (ERROR_STATUS[error.code]) {
        return res.json({ success: true, available: false, error: error.message, code: error.code });
      }
      console.error('Check referral availability error:', error);
      res.status(500).json({ success: false, error: 'Кодыг шалгаж чадсангүй.' });
    }
  }

  // POST /referral/code — claim a self-chosen code. One per account, ever.
  async createCode(req, res) {
    try {
      const settings = await referrals.getReferralSettings(this.dbHelpers);
      if (!settings.enabled) {
        return res.status(503).json({ success: false, error: 'Урилгын хөтөлбөр одоогоор идэвхгүй байна.' });
      }

      const created = await referrals.createCodeForUser(
        this.dbHelpers, req.session.userId, req.body.code
      );

      await recordUserAction(this.dbHelpers, req, ACTIONS.REFERRAL_CODE_CREATED, {
        entityType: 'referral_code',
        entityId: created.id,
        details: { code: created.code }
      });

      res.json({
        success: true,
        message: `"${created.code}" код амжилттай үүслээ. Найзууддаа хуваалцаарай!`,
        code: created.code,
        bonusPercent: settings.bonusPercent,
        commissionPercent: settings.commissionPercent
      });
    } catch (error) {
      this.respondWithError(res, error, 'Код үүсгэж чадсангүй.');
    }
  }

  // POST /referral/apply — bind permanently to someone else's code.
  async applyCode(req, res) {
    try {
      const result = await referrals.bindCodeToUser(
        this.dbHelpers, req.session.userId, req.body.code
      );

      await recordUserAction(this.dbHelpers, req, ACTIONS.REFERRAL_CODE_APPLIED, {
        entityType: 'user',
        entityId: req.session.userId,
        details: { code: result.code, referrer: result.referrerUsername }
      });

      res.json({
        success: true,
        message: `"${result.code}" код идэвхжлээ. Захиалга бүрт +${result.bonusPercent}% Robux нэмэгдэнэ.`,
        ...result
      });
    } catch (error) {
      this.respondWithError(res, error, 'Кодыг идэвхжүүлж чадсангүй.');
    }
  }

  // ------------------------------------------------------------------
  // Admin
  // ------------------------------------------------------------------

  async getSettings(req, res) {
    try {
      const settings = await referrals.getReferralSettings(this.dbHelpers);
      res.json({ success: true, settings });
    } catch (error) {
      console.error('Get referral settings error:', error);
      res.status(500).json({ success: false, error: 'Тохиргоог авч чадсангүй.' });
    }
  }

  // PUT /admin/referrals/settings — the adjustable knobs.
  async updateSettings(req, res) {
    const bonusPercent = Number(req.body.bonusPercent);
    const commissionPercent = Number(req.body.commissionPercent);
    const maxBonusRobux = Number(req.body.maxBonusRobux ?? 0);
    const minPayoutRobux = Number(req.body.minPayoutRobux ?? 0);
    const bonusScope = req.body.bonusScope === 'first_order' ? 'first_order' : 'every_order';
    const enabled = req.body.enabled ? '1' : '0';
    const newCustomersOnly = req.body.newCustomersOnly ? '1' : '0';

    // Capped at 50% because both percentages are paid out of margin — a
    // typo of 500 here would quietly sell Robux at a loss on every order.
    if (!Number.isFinite(bonusPercent) || bonusPercent < 0 || bonusPercent > 50) {
      return res.status(400).json({ success: false, error: 'Хэрэглэгчийн бонус 0-50% хооронд байна.' });
    }
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 50) {
      return res.status(400).json({ success: false, error: 'Инфлюенсерийн шимтгэл 0-50% хооронд байна.' });
    }
    if (!Number.isInteger(maxBonusRobux) || maxBonusRobux < 0) {
      return res.status(400).json({ success: false, error: 'Дээд хязгаар 0 буюу түүнээс их бүхэл тоо байна.' });
    }
    if (!Number.isInteger(minPayoutRobux) || minPayoutRobux < 0) {
      return res.status(400).json({ success: false, error: 'Доод төлөлт 0 буюу түүнээс их бүхэл тоо байна.' });
    }

    try {
      await Promise.all([
        ['referral_enabled', enabled],
        ['referral_bonus_percent', String(bonusPercent)],
        ['referral_commission_percent', String(commissionPercent)],
        ['referral_bonus_scope', bonusScope],
        ['referral_max_bonus_robux', String(maxBonusRobux)],
        ['referral_new_customers_only', newCustomersOnly],
        ['referral_min_payout_robux', String(minPayoutRobux)]
      ].map(([key, value]) => promisify(this.dbHelpers, 'setSetting', key, value)));

      await recordAdminAction(this.dbHelpers, req, ACTIONS.SETTING_UPDATED, {
        entityType: 'setting',
        details: {
          setting: 'referrals',
          enabled: enabled === '1',
          bonusPercent,
          commissionPercent,
          bonusScope,
          maxBonusRobux,
          newCustomersOnly: newCustomersOnly === '1'
        }
      });

      // Existing orders keep the percentage they were created with, so this
      // only affects orders placed from now on.
      res.json({
        success: true,
        message: 'Урилгын тохиргоо шинэчлэгдлээ. Шинэ захиалгуудад үйлчилнэ.',
        settings: await referrals.getReferralSettings(this.dbHelpers)
      });
    } catch (error) {
      console.error('Update referral settings error:', error);
      res.status(500).json({ success: false, error: 'Тохиргоог хадгалж чадсангүй.' });
    }
  }

  async getCodes(req, res) {
    try {
      const [codes, settings] = await Promise.all([
        promisify(this.dbHelpers, 'getAllReferralCodes'),
        referrals.getReferralSettings(this.dbHelpers)
      ]);

      res.json({
        success: true,
        defaultBonusPercent: settings.bonusPercent,
        defaultCommissionPercent: settings.commissionPercent,
        codes: codes.map((row) => ({
          id: row.id,
          code: row.code,
          ownerUserId: row.user_id,
          ownerUsername: row.owner_username,
          ownerRobloxId: row.owner_roblox_id,
          isInfluencer: Boolean(row.is_influencer),
          isActive: Boolean(row.is_active),
          bonusPercentOverride: row.bonus_percent_override,
          commissionPercentOverride: row.commission_percent_override,
          referredUsers: Number(row.referred_users),
          completedOrders: Number(row.completed_orders),
          drivenRobux: Number(row.driven_robux),
          earnedRobux: Number(row.earned_robux),
          paidOutRobux: Number(row.paid_out_robux),
          balanceRobux: Number(row.earned_robux) - Number(row.paid_out_robux),
          createdAt: row.created_at
        }))
      });
    } catch (error) {
      console.error('Get referral codes error:', error);
      res.status(500).json({ success: false, error: 'Урилгын кодуудыг авч чадсангүй.' });
    }
  }

  // PUT /admin/referrals/codes/:id — flag a creator as a partner and give
  // them their own terms. Null overrides mean "follow the global setting".
  async updateCodeTerms(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Кодын ID буруу байна.' });
    }

    const parsePercent = (value, label) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) {
        throw Object.assign(new Error(`${label} 0-50% хооронд байна.`), { code: 'BAD_PERCENT' });
      }
      return parsed;
    };

    try {
      const bonusOverride = parsePercent(req.body.bonusPercentOverride, 'Бонус');
      const commissionOverride = parsePercent(req.body.commissionPercentOverride, 'Шимтгэл');

      const result = await promisify(
        this.dbHelpers, 'updateReferralCodeTerms',
        id,
        Boolean(req.body.isInfluencer),
        bonusOverride,
        commissionOverride,
        req.body.isActive === undefined ? true : Boolean(req.body.isActive)
      );
      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Код олдсонгүй.' });
      }

      await recordAdminAction(this.dbHelpers, req, ACTIONS.REFERRAL_TERMS_UPDATED, {
        entityType: 'referral_code',
        entityId: id,
        details: {
          isInfluencer: Boolean(req.body.isInfluencer),
          bonusPercentOverride: bonusOverride,
          commissionPercentOverride: commissionOverride,
          isActive: req.body.isActive === undefined ? true : Boolean(req.body.isActive)
        }
      });

      res.json({ success: true, message: 'Кодын нөхцөл шинэчлэгдлээ.' });
    } catch (error) {
      if (error.code === 'BAD_PERCENT') {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Update referral terms error:', error);
      res.status(500).json({ success: false, error: 'Нөхцөлийг шинэчилж чадсангүй.' });
    }
  }

  // POST /admin/referrals/codes/:id/payout — record Robux handed to a creator.
  //
  // This records a payout that happened; it does not send Robux. Paying a
  // creator uses the same group payout the shop already runs, and conflating
  // "we owe this" with "we sent this" is how ledgers end up lying.
  async recordPayout(req, res) {
    const id = Number(req.params.id);
    const robuxAmount = Number(req.body.robuxAmount);
    const note = String(req.body.note || '').trim().slice(0, 300);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Кодын ID буруу байна.' });
    }
    if (!Number.isInteger(robuxAmount) || robuxAmount < 1) {
      return res.status(400).json({ success: false, error: 'Robux дүнг эерэг бүхэл тоогоор оруулна уу.' });
    }

    try {
      const code = await promisify(this.dbHelpers, 'getReferralCodeById', id);
      if (!code) {
        return res.status(404).json({ success: false, error: 'Код олдсонгүй.' });
      }

      const stats = await promisify(this.dbHelpers, 'getReferralStats', id);
      // Paying more than was earned would make the balance negative and the
      // ledger meaningless. Only credited earnings count towards this.
      if (robuxAmount > stats.balanceRobux) {
        return res.status(409).json({
          success: false,
          error: `Үлдэгдлээс их дүн төлөх боломжгүй. Одоогийн үлдэгдэл: ${stats.balanceRobux} R$.`
        });
      }

      await promisify(
        this.dbHelpers, 'createReferralPayout',
        id, code.user_id, robuxAmount, note || null, req.session?.adminId ?? null
      );

      await recordAdminAction(this.dbHelpers, req, ACTIONS.REFERRAL_PAYOUT_RECORDED, {
        entityType: 'referral_code',
        entityId: id,
        details: { code: code.code, robuxAmount, note: note || null }
      });

      res.json({
        success: true,
        message: `${robuxAmount.toLocaleString('mn-MN')} R$ төлөлт бүртгэгдлээ.`,
        balanceRobux: stats.balanceRobux - robuxAmount
      });
    } catch (error) {
      console.error('Record referral payout error:', error);
      res.status(500).json({ success: false, error: 'Төлөлтийг бүртгэж чадсангүй.' });
    }
  }
}

module.exports = ReferralController;
