const { computeLevel, parseThresholds } = require('./levels');

function getSettingValue(dbHelpers, key, fallback = '') {
  return new Promise((resolve, reject) => {
    dbHelpers.getSetting(key, (error, row) => (error ? reject(error) : resolve(row?.value ?? fallback)));
  });
}

async function getUserLevelDiscountPercent(dbHelpers, userId) {
  const [total, levelSetting] = await Promise.all([
    new Promise((resolve, reject) => {
      dbHelpers.getUserPurchasedTotal(userId, (error, value) => (error ? reject(error) : resolve(value)));
    }),
    getSettingValue(dbHelpers, 'level_thresholds', '[]')
  ]);
  const { discountPercent } = computeLevel(total, parseThresholds(levelSetting));
  return discountPercent || 0;
}

// Resolves the final MNT price and delivered Robux for a fixed-package
// purchase (a normal order or a gift card) — combining the package's own
// manually-set discount with the buyer's level discount. Both are looked up
// here, server-side, from the buyer's real purchase history and the
// package's stored fields — never taken from the client, so neither can be
// forged.
//
// The event bonus and the referral bonus both add Robux without changing the
// price, and they are added rather than compounded: a 10% event running
// alongside a 5% referral gives 15% more Robux, not 15.5%. Additive keeps
// the promise legible — the two numbers a customer is shown sum to the one
// they receive.
async function priceForPackage(
  dbHelpers, userId, pkg, eventBonusPercent = 0, referralBonusPercent = 0, maxReferralBonusRobux = 0
) {
  const levelDiscountPercent = await getUserLevelDiscountPercent(dbHelpers, userId);
  const packageDiscountPercent = Number(pkg.discount_percent) || 0;
  const amountMnt = Math.round(
    pkg.price_mnt * (1 - packageDiscountPercent / 100) * (1 - levelDiscountPercent / 100)
  );

  const baseRobux = pkg.robux_amount;
  const eventBonusRobux = Math.round(baseRobux * (eventBonusPercent / 100));

  // Capped separately, because the cap is a limit on what the referral
  // programme costs us — not on the customer's total bonus.
  let referralBonusRobux = Math.floor(baseRobux * (referralBonusPercent / 100));
  if (maxReferralBonusRobux > 0) {
    referralBonusRobux = Math.min(referralBonusRobux, maxReferralBonusRobux);
  }

  return {
    amountMnt,
    deliveredRobux: baseRobux + eventBonusRobux + referralBonusRobux,
    levelDiscountPercent,
    packageDiscountPercent,
    eventBonusRobux,
    referralBonusRobux
  };
}

module.exports = { getUserLevelDiscountPercent, priceForPackage };
