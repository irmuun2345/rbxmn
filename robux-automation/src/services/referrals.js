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
  'RBX', 'RBXMN', 'GIFT', 'ADMIN', 'ROOT', 'SYSTEM', 'SUPPORT', 'OFFICIAL', 'HELP',
  'NULL', 'NONE', 'TEST', 'ROBUX', 'FREE', 'BONUS'
]);

// Both halves of the programme — the customer's bonus and the creator's
// commission — are paid out of the margin on the order, so the band they may
// be set to is deliberately narrow. 0 is allowed and means that half is
// switched off; anything above 0 must land between 1% and 5%.
const PERCENT_MIN = 1;
const PERCENT_MAX = 5;

// Validates a percentage an admin typed. Returns null for "no value", which
// a per-code override reads as "follow the global setting" — distinct from 0,
// which means "this code pays nothing".
function normalisePercent(value, label, { allowNull = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw fail(`${label} оруулна уу.`, 'PERCENT_REQUIRED');
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw fail(`${label} тоо байх ёстой.`, 'PERCENT_INVALID');
  }
  if (parsed === 0) return 0;
  if (parsed < PERCENT_MIN || parsed > PERCENT_MAX) {
    throw fail(
      `${label} ${PERCENT_MIN}-${PERCENT_MAX}% хооронд байна (0 = унтраасан).`,
      'PERCENT_RANGE'
    );
  }
  return parsed;
}

// Holds a stored percentage inside the band without rejecting it. Used on
// read, where throwing would take the storefront down over a stale setting.
function clampToBand(percent) {
  if (percent <= 0) return 0;
  return Math.min(Math.max(percent, PERCENT_MIN), PERCENT_MAX);
}

// The cap on how many customers may ever bind a code. 0 is uncapped.
function normaliseMaxUses(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw fail('Ашиглах тоог 0 буюу түүнээс их бүхэл тоогоор оруулна уу. (0 = хязгааргүй)', 'MAX_USES_INVALID');
  }
  return parsed;
}

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
    // Clamped on the way out, not only on the way in. A value stored before
    // the 1–5% band existed would otherwise keep paying its old rate on every
    // order until someone happened to re-save the settings form.
    bonusPercent: clampToBand(Number(bonusPercent) || 0),
    commissionPercent: clampToBand(Number(commissionPercent) || 0),
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
  // A self-claimed code carries no negotiated terms: no usage cap and no
  // overrides, so it follows the global settings. Only an admin can set
  // those, via issueCodeForOwner.
  return issueCodeForOwner(dbHelpers, { ownerUserId: userId, rawCode });
}

// Issues a code to an account, with the terms the admin negotiated for it.
//
// Two things can go wrong and both are handled by the database rather than by
// checking first: the owner already has a code (UNIQUE user_id) and the code
// is already taken (UNIQUE code). Checking beforehand would leave a race
// between the check and the insert; letting the constraint decide cannot.
async function issueCodeForOwner(dbHelpers, {
  ownerUserId, rawCode, maxUses, bonusPercent, commissionPercent,
  isInfluencer = false, adminId = null
}) {
  const code = normaliseCode(rawCode);
  const record = {
    userId: ownerUserId,
    code,
    isInfluencer,
    bonusPercentOverride: normalisePercent(bonusPercent, 'Урамшуулал'),
    commissionPercentOverride: normalisePercent(commissionPercent, 'Шимтгэл'),
    maxUses: normaliseMaxUses(maxUses),
    createdByAdminId: adminId
  };

  try {
    const created = await promisify(dbHelpers, 'createReferralCode', record);
    return { id: created.id, code, maxUses: record.maxUses };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Which constraint tripped decides what the caller is told.
      const existing = await promisify(dbHelpers, 'getReferralCodeByUserId', ownerUserId);
      if (existing) {
        throw fail(
          `Энэ хэрэглэгчид аль хэдийн "${existing.code}" гэсэн код байна. Нэг хүн нэг код эзэмшинэ.`,
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

  // The cap is checked inside the INSERT, not here — see the repository. A
  // check at this point would be advisory only, because another customer can
  // take the last slot between it and the insert.
  const maxUses = Number(referralCode.max_uses) || 0;
  let result;
  try {
    result = await promisify(
      dbHelpers, 'bindReferralAttribution',
      refereeUserId, referralCode.id, referralCode.user_id, maxUses
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw fail('Та аль хэдийн урилгын кодтой холбогдсон байна.', 'ALREADY_REFERRED');
    }
    throw error;
  }

  // Zero rows inserted means the guard rejected it: the code is spent.
  if (!result.bound) {
    throw fail(
      `"${referralCode.code}" код ашиглах хязгаартаа хүрсэн байна (${maxUses} хүн). Өөр код оруулна уу.`,
      'CODE_EXHAUSTED'
    );
  }

  const uses = await promisify(dbHelpers, 'countReferralUses', referralCode.id);

  return {
    code: referralCode.code,
    referrerUsername: referralCode.owner_username,
    bonusPercent: clampToBand(referralCode.bonus_percent_override ?? settings.bonusPercent),
    maxUses,
    usedCount: uses,
    remainingUses: maxUses > 0 ? Math.max(maxUses - uses, 0) : null
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
  let bonusPercent = clampToBand(attribution.bonus_percent_override ?? settings.bonusPercent);
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
    commissionPercent: clampToBand(
      attribution.commission_percent_override ?? settings.commissionPercent
    ),
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
  PERCENT_MIN,
  PERCENT_MAX,
  RESERVED_CODES,
  ORDER_STATUS,
  getReferralSettings,
  normaliseCode,
  normalisePercent,
  normaliseMaxUses,
  clampToBand,
  createCodeForUser,
  issueCodeForOwner,
  isCodeAvailable,
  bindCodeToUser,
  resolveTermsForUser,
  calculateBonusRobux,
  calculateCommissionRobux,
  recordPendingEarning,
  creditEarningForOrder,
  reverseEarningForOrder
};
