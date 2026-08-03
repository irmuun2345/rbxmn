const { ensurePhoneLinked } = require('./phone-controller');
const { priceForPackage } = require('../services/pricing');
const { generateUniqueReference } = require('../services/payment-reference');
const { checkEligibility } = require('../services/group-eligibility');
const referrals = require('../services/referrals');
const { ORDER_STATUS } = require('../services/order-status');

// Roblox takes 30% of a Game Pass sale, so the seller keeps 0.70 of the list
// price. To put N Robux in the buyer's hands we must therefore list — and pay
// — N / 0.70, not N * 1.30: those are different numbers (1143 vs 1040 for an
// 800 R$ order), and the second one silently short-changes the buyer by ~9%
// because 1040 * 0.70 = 728, not 800.
const SELLER_PAYOUT_RATE = 0.70;

// The Game Pass is a delivery mechanism, not a product the buyer is choosing
// to publish — so we name it, not them. Asking a teenager buying Robux to
// invent a pass name and description was our plumbing leaking into their task,
// and every value they typed was thrown away anyway.
//
// The payment reference goes in the name because that is the one string an
// admin already has in front of them when reconciling a bank transfer: seeing
// the same code on the Roblox pass is what makes "is this the right pass?"
// answerable at a glance. Roblox caps pass names at 50 characters, and
// `RBX 1,700 R$ · RBX-K7M2QP` sits comfortably inside that.
function buildGamePassIdentity(deliveredRobux, paymentReference) {
  return {
    name: `RBX ${deliveredRobux} R$ · ${paymentReference}`.slice(0, 50),
    description:
      `RBX захиалга ${paymentReference}. Энэ Game Pass нь зөвхөн энэ захиалгын `
      + `${deliveredRobux} Robux-ийг хүргэхэд ашиглагдана. Худалдан авалт `
      + 'баталгаажсаны дараа устгаж болно.'
  };
}

class GamePassController {
  constructor(dbHelpers, RobloxAuth) {
    this.dbHelpers = dbHelpers;
    this.RobloxAuth = RobloxAuth;
  }

  getSettingValue(key) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getSetting(key, (error, row) => {
        if (error) reject(error);
        else resolve(row?.value || '');
      });
    });
  }

  getActiveOrderForUser(userId) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getActiveOrderForUser(userId, (error, row) => (error ? reject(error) : resolve(row)));
    });
  }

  // The account customers transfer to. Always read fresh, so an order created
  // a second after an admin edited it quotes the new account.
  async getBankDetails() {
    const [name, accountNumber, accountHolder] = await Promise.all([
      this.getSettingValue('bank_name'),
      this.getSettingValue('bank_account_number'),
      this.getSettingValue('bank_account_holder')
    ]);
    return { name, accountNumber, accountHolder };
  }

  // Prices one package for one buyer.
  //
  // Both order routes go through here, and that is the point: they used to
  // carry a copy of this sequence each, so any change to how bonuses or
  // discounts are applied had to be made twice or the two routes would quote
  // different totals for the same package.
  //
  // Every input is read server-side. The client sends a package id and
  // nothing else — no price, no bonus, no referral code — so there is nothing
  // in the request that can move the number.
  async quotePackage(userId, packageId) {
    const pkg = await new Promise((resolve, reject) => {
      this.dbHelpers.getPackageById(Number(packageId), (error, row) => (error ? reject(error) : resolve(row)));
    });
    if (!pkg || !pkg.is_active) {
      const error = new Error('Сонгосон Robux багц олдсонгүй.');
      error.code = 'PACKAGE_NOT_FOUND';
      throw error;
    }

    const desiredRobux = pkg.robux_amount;
    const event = await this.getActiveEventBonus();
    const bonusPercent = event?.bonusPercent || 0;
    // Resolved server-side from the buyer's stored attribution — the client
    // never sends a referral code at checkout, so the bonus can't be forged by
    // anyone who simply knows a creator's code.
    const terms = await referrals.resolveTermsForUser(this.dbHelpers, userId);
    const priced = await priceForPackage(
      this.dbHelpers, userId, pkg, bonusPercent, terms.bonusPercent, terms.maxBonusRobux
    );

    return {
      pkg,
      desiredRobux,
      event,
      bonusPercent,
      terms,
      ...priced,
      ratePer100Mnt: Math.round((priced.amountMnt / desiredRobux) * 100)
    };
  }

  // The fields both order routes return. Each adds its own on top — the Game
  // Pass id and purchase URL for one, the group link for the other.
  static quoteResponse(quote, { orderId, paymentReference, bank }) {
    const { terms } = quote;
    return {
      success: true,
      orderId,
      requestedRobux: quote.desiredRobux,
      deliveredRobux: quote.deliveredRobux,
      bonusPercent: quote.bonusPercent,
      eventName: quote.event?.name || null,
      referralCode: terms.active ? terms.code : null,
      referralBonusPercent: terms.active ? terms.bonusPercent : 0,
      referralBonusRobux: quote.referralBonusRobux,
      packageDiscountPercent: quote.packageDiscountPercent,
      levelDiscountPercent: quote.levelDiscountPercent,
      amountMnt: quote.amountMnt,
      ratePer100Mnt: quote.ratePer100Mnt,
      paymentReference,
      bank,
      status: 'awaiting_payment'
    };
  }

  // Resends the same order already in flight instead of creating a second
  // one — the frontend just shows the same payment panel again.
  async respondWithExistingOrder(res, order) {
    res.json({
      success: true,
      message: 'Танд аль хэдийн хүлээгдэж буй захиалга байна.',
      orderId: order.id,
      gamePassId: order.roblox_gamepass_id,
      purchaseUrl: order.roblox_gamepass_id ? `https://www.roblox.com/game-pass/${order.roblox_gamepass_id}` : null,
      requestedRobux: order.price,
      deliveredRobux: order.delivered_robux || order.price,
      bonusPercent: Number(order.bonus_percent) || 0,
      listedPrice: order.listed_price,
      amountMnt: order.amount_mnt,
      ratePer100Mnt: order.rate_per_100_mnt,
      paymentReference: order.payment_reference,
      deliveryMethod: order.delivery_method,
      bank: await this.getBankDetails(),
      status: order.status
    });
  }

  // Stamps the referral terms onto the order and opens a pending earning.
  //
  // Both writes are best-effort by design: the customer has already been
  // quoted a price and had a real Game Pass created for them, so a failure in
  // referral bookkeeping must never turn into a failed order. A lost earning
  // is a support ticket; a lost order is someone's money.
  async attachReferralToOrder(orderId, terms, orderRobux, bonusRobux) {
    if (!terms.active) return;

    try {
      await new Promise((resolve, reject) => {
        this.dbHelpers.transitionOrderStatus(
          orderId,
          [ORDER_STATUS.AWAITING_PAYMENT],
          ORDER_STATUS.AWAITING_PAYMENT,
          { referral_code_id: terms.referralCodeId, referral_bonus_percent: terms.bonusPercent },
          (error, result) => (error ? reject(error) : resolve(result))
        );
      });

      await referrals.recordPendingEarning(this.dbHelpers, {
        terms: { ...terms, refereeUserId: terms.refereeUserId },
        orderId,
        orderRobux,
        bonusRobux
      });
    } catch (error) {
      console.error(`Failed to attach referral to order #${orderId}:`, error.message);
    }
  }

  // The bonus % is always looked up here, server-side, at the moment of
  // purchase — never taken from the client — so it can't be forged.
  getActiveEventBonus() {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getActiveEvent((error, event) => {
        if (error) reject(error);
        else resolve(event ? { name: event.name, bonusPercent: Number(event.bonus_percent), endsAt: event.ends_at } : null);
      });
    });
  }

  async createGamePass(req, res) {
    const { packageId, universeId } = req.body;
    const authorizedUniverseIds = (req.session.authorizedUniverseIds || []).map(String);

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'Эхлээд Roblox аккаунтаа холбоно уу.' });
    }

    if (!Number.isInteger(Number(packageId))) {
      return res.status(400).json({ success: false, error: 'Robux багцаа сонгоно уу.' });
    }

    if (
      !req.session.robloxAccessToken
      || Number(req.session.robloxAccessTokenExpiresAt) <= Date.now()
    ) {
      return res.status(401).json({
        success: false,
        error: 'Roblox зөвшөөрлийн хугацаа дууссан. QR-аар дахин холбоно уу.'
      });
    }

    // The buyer only has to choose an experience when they authorized more
    // than one. With exactly one there is nothing to decide, so deciding it
    // for them removes a step; with none, no amount of UI helps — say so
    // plainly and point at the route that does work.
    if (!authorizedUniverseIds.length) {
      return res.status(403).json({
        success: false,
        error:
          'Танд Game Pass үүсгэх боломжтой Roblox experience алга байна. '
          + 'Группд элсээд хүлээвэл Robux шууд шилжүүлэх боломжтой болно.',
        reason: 'no_authorized_universe'
      });
    }

    // Auto-selection only fills a gap; it never overrides. A client that
    // names a universe is always held to it, so asking for one we were not
    // granted stays a 403 rather than quietly succeeding against a different
    // experience than the caller asked for.
    const requestedUniverseId = String(universeId || '');
    const normalizedUniverseId = requestedUniverseId
      || (authorizedUniverseIds.length === 1 ? authorizedUniverseIds[0] : '');

    if (!/^\d+$/.test(normalizedUniverseId)) {
      return res.status(400).json({
        success: false,
        error: 'Аль experience дээр үүсгэхээ сонгоно уу.',
        reason: 'universe_required'
      });
    }

    if (!authorizedUniverseIds.includes(normalizedUniverseId)) {
      return res.status(403).json({
        success: false,
        error: 'Энэ experience-д Game Pass үүсгэх зөвшөөрөл өгөөгүй байна.'
      });
    }

    try {
      await ensurePhoneLinked(this.dbHelpers, req.session.userId);

      const existing = await this.getActiveOrderForUser(req.session.userId);
      if (existing) {
        return this.respondWithExistingOrder(res, existing);
      }

      const quote = await this.quotePackage(req.session.userId, packageId);
      const { desiredRobux, deliveredRobux, terms, referralBonusRobux } = quote;
      const listedPrice = Math.ceil(deliveredRobux / SELLER_PAYOUT_RATE);

      // Reference first: the pass is named after it, so it has to exist
      // before we call Roblox. A reference burned by a later failure costs
      // nothing — they're random and there is no sequence to keep gapless.
      const paymentReference = await generateUniqueReference(this.dbHelpers);
      const { name, description } = buildGamePassIdentity(deliveredRobux, paymentReference);
      const robloxGamePass = await this.RobloxAuth.createGamePass({
        accessToken: req.session.robloxAccessToken,
        universeId: normalizedUniverseId,
        name,
        description,
        price: listedPrice
      });
      const gamePass = await new Promise((resolve, reject) => {
        this.dbHelpers.createGamePassOrder(
          req.session.userId,
          name,
          description,
          desiredRobux,
          robloxGamePass.gamePassId,
          normalizedUniverseId,
          listedPrice,
          quote.amountMnt,
          quote.ratePer100Mnt,
          paymentReference,
          deliveredRobux,
          quote.bonusPercent,
          (error, result) => error ? reject(error) : resolve(result)
        );
      });

      // Written as `pending`: the creator has earned nothing yet, and will
      // not until this order is actually delivered.
      await this.attachReferralToOrder(gamePass.id, terms, desiredRobux, referralBonusRobux);

      res.json({
        ...GamePassController.quoteResponse(quote, {
          orderId: gamePass.id,
          paymentReference,
          bank: await this.getBankDetails()
        }),
        message: 'Game Pass үүслээ. Төлбөр баталгаажуулах дараалалд нэмэгдлээ.',
        gamePassId: robloxGamePass.gamePassId,
        purchaseUrl: `https://www.roblox.com/game-pass/${robloxGamePass.gamePassId}`,
        listedPrice
      });
    } catch (error) {
      if (error.code === 'PHONE_NOT_LINKED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      if (error.code === 'PACKAGE_NOT_FOUND') {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Create Roblox game pass error:', error.response?.data || error.message);
      res.status(error.response?.status >= 400 && error.response?.status < 500 ? 400 : 502).json({
        success: false,
        error: 'Roblox дээр Game Pass үүсгэж чадсангүй. Experience-ийн зөвшөөрөл болон үнийг шалгана уу.'
      });
    }
  }

  async createGroupOrder(req, res) {
    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'Эхлээд Roblox аккаунтаа холбоно уу.' });
    }

    const packageId = Number(req.body.packageId);
    if (!Number.isInteger(packageId)) {
      return res.status(400).json({ success: false, error: 'Robux багцаа сонгоно уу.' });
    }

    try {
      await ensurePhoneLinked(this.dbHelpers, req.session.userId);

      const existing = await this.getActiveOrderForUser(req.session.userId);
      if (existing) {
        return this.respondWithExistingOrder(res, existing);
      }

      const groupId = await this.getSettingValue('group_id');
      if (!groupId) {
        return res.status(503).json({ success: false, error: 'Групп одоогоор тохируулагдаагүй байна.' });
      }

      // The route is the server's decision, not the client's. Without this
      // check a buyer could call this endpoint directly, skip the Gamepass
      // route entirely, and end up with a paid order that Roblox will refuse
      // to fulfil until their membership matures.
      const user = await new Promise((resolve, reject) => {
        this.dbHelpers.getUserById(req.session.userId, (error, row) => (error ? reject(error) : resolve(row)));
      });
      const eligibility = await checkEligibility(this.dbHelpers, user, groupId);
      if (!eligibility.eligible) {
        return res.status(403).json({
          success: false,
          error: eligibility.isMember
            ? `Группын payout авахад ${eligibility.requiredDays} хоногийн гишүүнчлэл шаардлагатай. Үлдсэн: ${eligibility.daysRemaining} хоног.`
            : `Эхлээд группд элсээрэй. Группын payout ${eligibility.requiredDays} хоногийн дараа боломжтой болно.`,
          reason: eligibility.reason,
          eligibility,
          // Tells the frontend what to offer instead.
          alternativeRoute: 'gamepass'
        });
      }

      const quote = await this.quotePackage(req.session.userId, packageId);
      const { desiredRobux, deliveredRobux, terms, referralBonusRobux } = quote;
      const paymentReference = await generateUniqueReference(this.dbHelpers);

      const order = await new Promise((resolve, reject) => {
        this.dbHelpers.createGroupOrder(
          req.session.userId,
          desiredRobux,
          quote.amountMnt,
          quote.ratePer100Mnt,
          paymentReference,
          deliveredRobux,
          quote.bonusPercent,
          (error, result) => (error ? reject(error) : resolve(result))
        );
      });

      await this.attachReferralToOrder(order.id, terms, desiredRobux, referralBonusRobux);

      res.json({
        ...GamePassController.quoteResponse(quote, {
          orderId: order.id,
          paymentReference,
          bank: await this.getBankDetails()
        }),
        message: 'Захиалга үүслээ. Төлбөр баталгаажуулах дараалалд нэмэгдлээ.',
        groupId,
        groupUrl: `https://www.roblox.com/groups/${groupId}`
      });
    } catch (error) {
      if (error.code === 'PHONE_NOT_LINKED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      if (error.code === 'PACKAGE_NOT_FOUND') {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Create group order error:', error.response?.data || error.message);
      res.status(500).json({ success: false, error: 'Захиалга үүсгэж чадсангүй. Дахин оролдоно уу.' });
    }
  }

  async getUserGamePasses(req, res) {
    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'Эхлээд Roblox аккаунтаа холбоно уу.' });
    }

    try {
      const gamePasses = await new Promise((resolve, reject) => {
        this.dbHelpers.getGamePassesByUserId(req.session.userId, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

      res.json({ success: true, gamePasses });
    } catch (error) {
      console.error('Get user game passes error:', error);
      res.status(500).json({ success: false, error: 'Game Pass жагсаалтыг авч чадсангүй.' });
    }
  }
}

module.exports = GamePassController;
