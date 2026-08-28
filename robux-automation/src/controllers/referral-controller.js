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
  CODE_EXHAUSTED: 409,
  ALREADY_HAS_CODE: 409,
  ALREADY_REFERRED: 409,
  SELF_REFERRAL: 403,
  NOT_NEW_CUSTOMER: 403,
  REFERRALS_DISABLED: 503,
  OWNER_REQUIRED: 400,
  OWNER_NOT_FOUND: 404,
  PERCENT_REQUIRED: 400,
  PERCENT_INVALID: 400,
  PERCENT_RANGE: 400,
  MAX_USES_INVALID: 400
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
      const maxUses = code ? Number(code.max_uses) || 0 : 0;

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
          bonusPercent: referrals.clampToBand(code.bonus_percent_override ?? settings.bonusPercent),
          commissionPercent: referrals.clampToBand(
            code.commission_percent_override ?? settings.commissionPercent
          ),
          // How much of the code's budget is left. null means uncapped —
          // distinct from 0, which means it is spent.
          maxUses,
          usedCount: stats.referredUsers,
          remainingUses: maxUses > 0 ? Math.max(maxUses - stats.referredUsers, 0) : null,
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

  // GET /referral/info — the two percentages, with no session behind the
  // request. The landing page quotes them at visitors who have not signed in
  // yet, and quoting a number the orders do not actually pay would be worse
  // than quoting none: this reads the same settings the payout path does.
  //
  // Nothing here is per-user. Balances, stats and code ownership stay on the
  // authenticated /referral/me.
  async getPublicInfo(req, res) {
    try {
      const settings = await referrals.getReferralSettings(this.dbHelpers);
      res.json({
        success: true,
        enabled: settings.enabled,
        bonusPercent: settings.bonusPercent,
        commissionPercent: settings.commissionPercent,
        minPayoutRobux: settings.minPayoutRobux
      });
    } catch (error) {
      console.error('Get public referral info error:', error);
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

    // Held to the 1–5% band because both percentages are paid out of margin —
    // a typo of 50 here would quietly sell Robux at a loss on every order.
    // 0 is allowed and switches that half of the programme off.
    try {
      referrals.normalisePercent(bonusPercent, 'Хэрэглэгчийн бонус', { allowNull: false });
      referrals.normalisePercent(commissionPercent, 'Инфлюенсерийн шимтгэл', { allowNull: false });
    } catch (error) {
      return res.status(400).json({ success: false, error: error.message, code: error.code });
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
        percentMin: referrals.PERCENT_MIN,
        percentMax: referrals.PERCENT_MAX,
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
          maxUses: Number(row.max_uses) || 0,
          // Uncapped codes report null rather than a number, so the UI never
          // has to guess whether 0 means "spent" or "no limit".
          remainingUses: Number(row.max_uses) > 0
            ? Math.max(Number(row.max_uses) - Number(row.referred_users), 0)
            : null,
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

  // POST /admin/referrals/codes — issue a code to an account.
  //
  // Codes are handed out, not claimed: the admin picks who owns it, what it
  // pays, and how many customers may ever redeem it. All three are set here
  // rather than being defaults the owner could change afterwards.
  async issueCode(req, res) {
    try {
      const settings = await referrals.getReferralSettings(this.dbHelpers);

      const username = String(req.body.ownerUsername || '').trim();
      if (!username) {
        return res.status(400).json({
          success: false, error: 'Кодыг эзэмших хэрэглэгчийн нэрийг оруулна уу.', code: 'OWNER_REQUIRED'
        });
      }

      const owner = await promisify(this.dbHelpers, 'getUserByUsername', username);
      if (!owner) {
        return res.status(404).json({
          success: false, error: `"${username}" нэртэй хэрэглэгч олдсонгүй.`, code: 'OWNER_NOT_FOUND'
        });
      }

      const created = await referrals.issueCodeForOwner(this.dbHelpers, {
        ownerUserId: owner.id,
        rawCode: req.body.code,
        maxUses: req.body.maxUses,
        bonusPercent: req.body.bonusPercentOverride,
        commissionPercent: req.body.commissionPercentOverride,
        isInfluencer: Boolean(req.body.isInfluencer),
        adminId: req.session?.adminId ?? null
      });

      await recordAdminAction(this.dbHelpers, req, ACTIONS.REFERRAL_CODE_CREATED, {
        entityType: 'referral_code',
        entityId: created.id,
        details: {
          code: created.code,
          owner: owner.username,
          maxUses: created.maxUses,
          bonusPercentOverride: req.body.bonusPercentOverride ?? null,
          commissionPercentOverride: req.body.commissionPercentOverride ?? null,
          isInfluencer: Boolean(req.body.isInfluencer)
        }
      });

      res.json({
        success: true,
        message: created.maxUses > 0
          ? `"${created.code}" код ${owner.username}-д олгогдлоо. ${created.maxUses} хүн ашиглана.`
          : `"${created.code}" код ${owner.username}-д олгогдлоо. Хязгааргүй.`,
        code: created.code,
        maxUses: created.maxUses,
        bonusPercent: req.body.bonusPercentOverride ?? settings.bonusPercent,
        commissionPercent: req.body.commissionPercentOverride ?? settings.commissionPercent
      });
    } catch (error) {
      this.respondWithError(res, error, 'Код олгож чадсангүй.');
    }
  }

  // PUT /admin/referrals/codes/:id — flag a creator as a partner and give
  // them their own terms. Null overrides mean "follow the global setting".
  async updateCodeTerms(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Кодын ID буруу байна.' });
    }

    try {
      const bonusOverride = referrals.normalisePercent(req.body.bonusPercentOverride, 'Бонус');
      const commissionOverride = referrals.normalisePercent(req.body.commissionPercentOverride, 'Шимтгэл');
      const maxUses = referrals.normaliseMaxUses(req.body.maxUses);

      const result = await promisify(
        this.dbHelpers, 'updateReferralCodeTerms',
        id,
        {
          isInfluencer: Boolean(req.body.isInfluencer),
          bonusPercentOverride: bonusOverride,
          commissionPercentOverride: commissionOverride,
          maxUses,
          isActive: req.body.isActive === undefined ? true : Boolean(req.body.isActive)
        }
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
          maxUses,
          isActive: req.body.isActive === undefined ? true : Boolean(req.body.isActive)
        }
      });

      res.json({ success: true, message: 'Кодын нөхцөл шинэчлэгдлээ.' });
    } catch (error) {
      this.respondWithError(res, error, 'Нөхцөлийг шинэчилж чадсангүй.');
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
          error: `Үлдэгдлээс их дүн төлөх боломжгүй. Одоогийн үлдэгдэл: ${stats.balanceRobux} Robux.`
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
        message: `${robuxAmount.toLocaleString('mn-MN')} Robux төлөлт бүртгэгдлээ.`,
        balanceRobux: stats.balanceRobux - robuxAmount
      });
    } catch (error) {
      console.error('Record referral payout error:', error);
      res.status(500).json({ success: false, error: 'Төлөлтийг бүртгэж чадсангүй.' });
    }
  }
}

module.exports = ReferralController;
