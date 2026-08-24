// Referral programme: content creators hand out a code, the customers who
// use it get bonus Robux, and the creator earns a commission on what those
// customers actually receive.
//
// The rule that shapes everything here is that a commission is only real
// once Robux have genuinely reached the customer. An approved payment is not
// enough — payments get approved and deliveries still fail. So an earning is
// written as `pending` when the order is created and only becomes `credited`
// when that order reaches COMPLETED. Balances count credited rows alone.

const { ORDER_STATUS } = require('./order-status');
const { isUniqueViolation } = require('../models/db-errors');

// Codes are chosen by the person who owns them, so they need to be readable
// and typeable: letters and digits only, nothing else. A creator's code is
// something they say out loud in a video.
const CODE_PATTERN = /^[A-Z0-9]{3,8}$/;
const CODE_MIN_LENGTH = 3;
const CODE_MAX_LENGTH = 8;

// Words that would let a code impersonate the service itself, or collide
// with how we label our own identifiers elsewhere.
const RESERVED_CODES = new Set([
  'RBX', 'GIFT', 'ADMIN', 'ROOT', 'SYSTEM', 'SUPPORT', 'OFFICIAL', 'HELP',
  'NULL', 'NONE', 'TEST', 'ROBUX', 'FREE', 'BONUS'
]);

function getSettingValue(dbHelpers, key, fallback = '') {
  return new Promise((resolve, reject) => {
    dbHelpers.getSetting(key, (error, row) => (error ? reject(error) : resolve(row?.value ?? fallback)));
  });
}

function promisify(dbHelpers, method, ...args) {
  return new Promise((resolve, reject) => {
    dbHelpers[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

// Reads every knob in one go. Called on each order, so it stays a single
// batch of cheap key reads rather than a query per value.
async function getReferralSettings(dbHelpers) {
  const [
    enabled, bonusPercent, commissionPercent, bonusScope,
    maxBonusRobux, newCustomersOnly, minPayoutRobux
  ] = await Promise.all([
    getSettingValue(dbHelpers, 'referral_enabled', '1'),
    getSettingValue(dbHelpers, 'referral_bonus_percent', '5'),
    getSettingValue(dbHelpers, 'referral_commission_percent', '10'),
    getSettingValue(dbHelpers, 'referral_bonus_scope', 'every_order'),
    getSettingValue(dbHelpers, 'referral_max_bonus_robux', '0'),
    getSettingValue(dbHelpers, 'referral_new_customers_only', '1'),
    getSettingValue(dbHelpers, 'referral_min_payout_robux', '100')
  ]);

  return {
    enabled: enabled === '1',
    bonusPercent: Number(bonusPercent) || 0,
    commissionPercent: Number(commissionPercent) || 0,
    bonusScope: bonusScope === 'first_order' ? 'first_order' : 'every_order',
    maxBonusRobux: Number(maxBonusRobux) || 0,
    newCustomersOnly: newCustomersOnly === '1',
    minPayoutRobux: Number(minPayoutRobux) || 0
  };
}

// Validates a user-supplied code and returns its canonical (uppercase) form.
// Throws rather than returning null so no caller can accidentally treat an
// invalid code as absent.
function normaliseCode(raw) {
  const code = String(raw || '').trim().toUpperCase();

  if (!code) {
    throw fail('Кодоо оруулна уу.', 'CODE_REQUIRED');
  }
  if (code.length < CODE_MIN_LENGTH || code.length > CODE_MAX_LENGTH) {
    throw fail(
      `Код ${CODE_MIN_LENGTH}-${CODE_MAX_LENGTH} тэмдэгт байна.`,
      'CODE_LENGTH'
    );
  }
  if (!CODE_PATTERN.test(code)) {
    throw fail('Код зөвхөн үсэг болон тооноос бүрдэнэ. Тэмдэгт, зай оруулж болохгүй.', 'CODE_CHARSET');
  }
  if (RESERVED_CODES.has(code)) {
    throw fail('Энэ код нөөцлөгдсөн байна. Өөр код сонгоно уу.', 'CODE_RESERVED');
  }

  return code;
}

// Claims a code for a user. Two things can go wrong and both are handled by
// the database rather than by checking first: the user already has a code
// (UNIQUE user_id) and the code is already taken (UNIQUE code). Checking
// beforehand would leave a race between the check and the insert; letting the
// constraint decide cannot.
async function createCodeForUser(dbHelpers, userId, rawCode) {
  const code = normaliseCode(rawCode);

  try {
    const created = await promisify(dbHelpers, 'createReferralCode', userId, code);
    return { id: created.id, code };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Which constraint tripped decides what the user is told.
      const existing = await promisify(dbHelpers, 'getReferralCodeByUserId', userId);
      if (existing) {
        throw fail(
          `Танд аль хэдийн "${existing.code}" гэсэн код байна. Нэг хүн нэг код үүсгэнэ.`,
          'ALREADY_HAS_CODE'
        );
      }
      throw fail('Энэ код аль хэдийн бүртгэгдсэн байна. Өөр код сонгоно уу.', 'CODE_TAKEN');
    }
    throw error;
  }
}

// Whether a code could be claimed right now. Only a hint for the UI — the
// UNIQUE index is what actually decides, because someone else may claim it
// between this check and the eventual insert.
async function isCodeAvailable(dbHelpers, rawCode) {
  const code = normaliseCode(rawCode);
  const existing = await promisify(dbHelpers, 'getReferralCodeByCode', code);
  return { code, available: !existing };
}

// Permanently attaches a customer to a creator's code.
async function bindCodeToUser(dbHelpers, refereeUserId, rawCode) {
  const settings = await getReferralSettings(dbHelpers);
  if (!settings.enabled) {
    throw fail('Урилгын хөтөлбөр одоогоор идэвхгүй байна.', 'REFERRALS_DISABLED');
  }

  const code = normaliseCode(rawCode);
  const referralCode = await promisify(dbHelpers, 'getReferralCodeByCode', code);

  if (!referralCode) {
    throw fail('Ийм код олдсонгүй.', 'CODE_NOT_FOUND');
  }
  if (!referralCode.is_active) {
    throw fail('Энэ код идэвхгүй болсон байна.', 'CODE_INACTIVE');
  }
  // Without this, every customer would simply refer themselves and the
  // commission would become an unconditional discount.
  if (referralCode.user_id === refereeUserId) {
    throw fail('Өөрийнхөө кодыг ашиглах боломжгүй.', 'SELF_REFERRAL');
  }

  const existing = await promisify(dbHelpers, 'getReferralAttribution', refereeUserId);
  if (existing) {
    throw fail(
      `Та аль хэдийн "${existing.code}" кодтой холбогдсон байна. Нэг л удаа холбогдоно.`,
      'ALREADY_REFERRED'
    );
  }

  // Referral marketing is for winning new customers. Without this an
  // established buyer could be attributed to a creator who had nothing to do
  // with bringing them in.
  if (settings.newCustomersOnly) {
    const completed = await promisify(dbHelpers, 'getUserCompletedOrderCount', refereeUserId);
    if (completed > 0) {
      throw fail(
        'Урилгын кодыг эхний захиалгаасаа өмнө оруулна. Танд аль хэдийн дууссан захиалга байна.',
        'NOT_NEW_CUSTOMER'
      );
    }
  }

  try {
    await promisify(
      dbHelpers, 'bindReferralAttribution',
      refereeUserId, referralCode.id, referralCode.user_id
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw fail('Та аль хэдийн урилгын кодтой холбогдсон байна.', 'ALREADY_REFERRED');
    }
    throw error;
  }

  return {
    code: referralCode.code,
    referrerUsername: referralCode.owner_username,
    bonusPercent: referralCode.bonus_percent_override ?? settings.bonusPercent
  };
}

// The percentages that apply to one specific customer's next order. A
// per-code override wins over the global setting; `?? ` rather than `||` so
// an override of 0 is honoured as "earns nothing" instead of falling through.
async function resolveTermsForUser(dbHelpers, userId) {
  const settings = await getReferralSettings(dbHelpers);
  if (!settings.enabled) {
    return { active: false, reason: 'disabled', bonusPercent: 0, commissionPercent: 0 };
  }

  const attribution = await promisify(dbHelpers, 'getReferralAttribution', userId);
  if (!attribution) {
    return { active: false, reason: 'not_referred', bonusPercent: 0, commissionPercent: 0 };
  }
  if (!attribution.is_active) {
    return { active: false, reason: 'code_inactive', bonusPercent: 0, commissionPercent: 0 };
  }

  // 'first_order' stops the customer's bonus after their first delivered
  // order; the creator's commission is unaffected, since the creator keeps
  // driving the sales either way.
  let bonusPercent = attribution.bonus_percent_override ?? settings.bonusPercent;
  if (settings.bonusScope === 'first_order') {
    const completed = await promisify(dbHelpers, 'getUserCompletedOrderCount', userId);
    if (completed > 0) bonusPercent = 0;
  }

  return {
    active: true,
    reason: null,
    referralCodeId: attribution.referral_code_id,
    referrerUserId: attribution.referrer_user_id,
    referrerUsername: attribution.referrer_username,
    refereeUserId: userId,
    code: attribution.code,
    bonusPercent,
    commissionPercent: attribution.commission_percent_override ?? settings.commissionPercent,
    maxBonusRobux: settings.maxBonusRobux
  };
}

// Applies the per-order cap to a bonus. Returns whole Robux — fractional
// Robux do not exist, and rounding down means the cap is never exceeded.
function calculateBonusRobux(baseRobux, bonusPercent, maxBonusRobux) {
  const raw = Math.floor(baseRobux * (bonusPercent / 100));
  if (maxBonusRobux > 0) return Math.min(raw, maxBonusRobux);
  return raw;
}

function calculateCommissionRobux(orderRobux, commissionPercent) {
  return Math.floor(orderRobux * (commissionPercent / 100));
}

// Records the earning for a newly created order as `pending`. Nothing is
// payable yet — this is a claim on a future delivery, not money.
//
// Never throws into the order path: a referral bookkeeping failure must not
// prevent a paid-for order from being created.
async function recordPendingEarning(dbHelpers, { terms, orderId, orderRobux, bonusRobux }) {
  if (!terms.active) return null;

  try {
    return await promisify(dbHelpers, 'createReferralEarning', {
      referralCodeId: terms.referralCodeId,
      referrerUserId: terms.referrerUserId,
      refereeUserId: terms.refereeUserId,
      orderId,
      orderRobux,
      bonusRobux,
      commissionRobux: calculateCommissionRobux(orderRobux, terms.commissionPercent),
      bonusPercent: terms.bonusPercent,
      commissionPercent: terms.commissionPercent
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // This order already has an earning. Correct outcome, nothing to do.
      return null;
    }
    console.error(`Failed to record referral earning for order #${orderId}:`, error.message);
    return null;
  }
}

// Turns a pending earning into a real, payable one. Called from exactly one
// place — the moment an order reaches COMPLETED — which is what makes
// "only actually delivered top-ups count" true rather than aspirational.
async function creditEarningForOrder(dbHelpers, orderId) {
  try {
    const result = await promisify(dbHelpers, 'creditReferralEarning', orderId);
    return Boolean(result.changes);
  } catch (error) {
    console.error(`Failed to credit referral earning for order #${orderId}:`, error.message);
    return false;
  }
}

// Cancels a pending earning when its order will never be delivered.
async function reverseEarningForOrder(dbHelpers, orderId) {
  try {
    const result = await promisify(dbHelpers, 'reverseReferralEarning', orderId);
    return Boolean(result.changes);
  } catch (error) {
    console.error(`Failed to reverse referral earning for order #${orderId}:`, error.message);
    return false;
  }
}

module.exports = {
  CODE_MIN_LENGTH,
  CODE_MAX_LENGTH,
  CODE_PATTERN,
  RESERVED_CODES,
  ORDER_STATUS,
  getReferralSettings,
  normaliseCode,
  createCodeForUser,
  isCodeAvailable,
  bindCodeToUser,
  resolveTermsForUser,
  calculateBonusRobux,
  calculateCommissionRobux,
  recordPendingEarning,
  creditEarningForOrder,
  reverseEarningForOrder
};
