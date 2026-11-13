const { ensurePhoneLinked } = require('./phone-controller');
const { isGamePassRouteEnabled, GAMEPASS_DISABLED_MESSAGE } = require('../services/gamepass-route');
const { messengerUrl, MESSENGER_NOT_CONFIGURED_MESSAGE } = require('../services/manual-route');
const { evaluateReadiness, readinessMessage, requiredMinimumAge } = require('../services/experience-readiness');
const { priceForPackage } = require('../services/pricing');
const { generateUniqueReference } = require('../services/payment-reference');
const { checkEligibility } = require('../services/group-eligibility');
const referrals = require('../services/referrals');
const { ORDER_STATUS } = require('../services/order-status');

// Roblox takes 30% of a Game Pass sale, so the seller keeps 0.70 of the list
// price. To put N Robux in the buyer's hands we must therefore list — and pay
// — N / 0.70, not N * 1.30: those are different numbers (1143 vs 1040 for an
// 800 Robux order), and the second one silently short-changes the buyer by ~9%
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
// `RBX 1,700 Robux · RBX-K7M2QP` sits comfortably inside that.
// What the buyer's Game Pass is called on Roblox: the brand, and nothing else.
//
// It used to carry the amount and the payment reference, on the reasoning that
// a pass showing "rbxmn 100 RBX-APN9YS" ties itself back to a bank transfer
// without anyone opening the admin queue. That redundancy is gone by choice.
// Reconciliation does not depend on it — an order stores its own
// roblox_gamepass_id and payment_reference, and the queue links the two — and
// Roblox moderates this text per item and asynchronously, so what a buyer
// actually sees on a pass page was never guaranteed to be the string sent
// here. A fixed brand is one less moderated string per order.
//
// Consequence worth knowing: looking at a pass on Roblox alone no longer tells
// you which order it belongs to. Match it by id through the admin queue.
const GAME_PASS_IDENTITY = { name: 'rbxmn', description: 'rbxmn' };

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

  // The accounts customers can transfer to. Always read fresh, so an order
  // created a second after an admin edited them quotes the new list.
  //
  // Returns every active account rather than one: the buyer transfers into
  // whichever bank is also theirs. Nothing downstream depends on which they
  // pick — a payment is tied to its order by the RBX-XXXXXX reference, not by
  // the account it landed in.
  async getBankDetails() {
    const rows = await new Promise((resolve, reject) => {
      this.dbHelpers.listActiveBankAccounts((error, result) => (error ? reject(error) : resolve(result)));
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.bank_name,
      accountNumber: row.account_number,
      accountHolder: row.account_holder
    }));
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
  static quoteResponse(quote, { orderId, paymentReference, banks }) {
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
      banks,
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
      messengerUrl: order.delivery_method === 'manual' ? messengerUrl() : null,
      banks: await this.getBankDetails(),
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

  async checkExperience(universeId, accessToken) {
    const universe = await this.RobloxAuth.getUniverse(universeId, accessToken);
    return evaluateReadiness(universe);
  }

  // What the storefront's setup checklist needs, and nothing more.
  static publicReadiness(universeId, readiness) {
    return {
      universeId: String(universeId),
      displayName: readiness.displayName,
      isPublic: readiness.isPublic,
      rated: readiness.rated,
      minimumAge: readiness.minimumAge,
      requiredAge: readiness.requiredAge,
      missing: readiness.missing,
      ready: readiness.ready,
      message: readinessMessage(readiness)
    };
  }

  // GET /gamepass/readiness — one row per experience the buyer granted us,
  // so the checklist can tick itself off as they finish each step on Roblox.
  // Only universes from this session's own grant are ever looked up.
  async getExperienceReadiness(req, res) {
    if (!isGamePassRouteEnabled()) {
      return res.status(403).json({ success: false, error: GAMEPASS_DISABLED_MESSAGE, reason: 'gamepass_route_disabled' });
    }

    const authorized = (req.session.authorizedUniverseIds || []).map(String);
    const requested = req.query.universeId ? String(req.query.universeId) : null;
    if (requested && !authorized.includes(requested)) {
      return res.status(403).json({ success: false, error: 'Энэ тоглоомд зөвшөөрөл өгөөгүй байна.' });
    }
    const universeIds = requested ? [requested] : authorized.slice(0, 10);

    const experiences = await Promise.all(universeIds.map(async (universeId) => {
      try {
        const readiness = await this.checkExperience(universeId, req.session.robloxAccessToken);
        return GamePassController.publicReadiness(universeId, readiness);
      } catch (error) {
        console.error(`Readiness check for universe ${universeId} failed:`, error.response?.status || error.message);
        return { universeId, ready: false, error: 'Roblox-оос шалгаж чадсангүй. Дахин оролдоно уу.' };
      }
    }));

    res.json({ success: true, requiredAge: requiredMinimumAge(), experiences });
  }

  // POST /gamepass/make-public — EXPERIMENT. Tries to switch the buyer's
  // experience to Public for them, then re-reads it from Roblox: the answer
  // to "did it work" is the universe's visibility afterwards, not the PATCH
  // status. Any failure leaves the manual step in place, so nothing is lost
  // when Roblox refuses.
  async makeExperiencePublic(req, res) {
    if (!isGamePassRouteEnabled()) {
      return res.status(403).json({ success: false, error: GAMEPASS_DISABLED_MESSAGE, reason: 'gamepass_route_disabled' });
    }

    const universeId = String(req.body?.universeId || '');
    const authorized = (req.session.authorizedUniverseIds || []).map(String);
    if (!/^\d+$/.test(universeId) || !authorized.includes(universeId)) {
      return res.status(403).json({ success: false, error: 'Энэ тоглоомд зөвшөөрөл өгөөгүй байна.' });
    }
    if (!req.session.robloxAccessToken || Number(req.session.robloxAccessTokenExpiresAt) <= Date.now()) {
      return res.status(401).json({ success: false, error: 'Roblox зөвшөөрлийн хугацаа дууссан. Дахин нэвтэрнэ үү.' });
    }

    const token = req.session.robloxAccessToken;
    let before;
    try {
      before = await this.checkExperience(universeId, token);
    } catch (error) {
      console.error('make-public: readiness read failed:', error.response?.status || error.message);
      return res.status(502).json({ success: false, error: 'Тоглоомын тохиргоог Roblox-оос шалгаж чадсангүй. Дахин оролдоно уу.' });
    }

    if (before.isPublic) {
      return res.json({ success: true, readiness: GamePassController.publicReadiness(universeId, before) });
    }

    try {
      await this.RobloxAuth.setUniversePublic(universeId, token);
    } catch (error) {
      // The experiment's result lives in this log line. 403 usually means the
      // session predates the universe:write scope; 400 means the field is not
      // writable through Open Cloud.
      console.error(
        `make-public: Roblox refused PATCH visibility on universe ${universeId}:`,
        error.response?.status,
        JSON.stringify(error.response?.data || error.message)
      );
      const status = error.response?.status;
      return res.status(status === 401 || status === 403 ? 403 : 502).json({
        success: false,
        error: status === 401 || status === 403
          ? 'Автоматаар Public болгох зөвшөөрөл алга. Дахин нэвтэрч зөвшөөрөх эсвэл Settings хэсгээс өөрөө Public болгоно уу.'
          : 'Автоматаар Public болгож чадсангүй. Creator Dashboard → Settings хэсгээс өөрөө Public болгоно уу.',
        reason: 'make_public_refused'
      });
    }

    let after;
    try {
      after = await this.checkExperience(universeId, token);
    } catch {
      after = before;
    }
    console.log(`make-public: universe ${universeId} PATCH accepted; visibility now public=${after.isPublic}`);

    if (!after.isPublic) {
      return res.status(502).json({
        success: false,
        error: 'Roblox хүсэлтийг хүлээж авсан ч тоглоом Public болсонгүй. Settings хэсгээс өөрөө Public болгоно уу.',
        reason: 'make_public_no_effect',
        readiness: GamePassController.publicReadiness(universeId, after)
      });
    }
    res.json({ success: true, readiness: GamePassController.publicReadiness(universeId, after) });
  }

  async createGamePass(req, res) {
    const { packageId, universeId } = req.body;
    const authorizedUniverseIds = (req.session.authorizedUniverseIds || []).map(String);

    // Refused here as well as hidden in the storefront: the client decides what
    // to render, the server decides what may exist. Taking money for a delivery
    // Roblox no longer permits is the failure this prevents.
    if (!isGamePassRouteEnabled()) {
      return res.status(403).json({
        success: false,
        error: GAMEPASS_DISABLED_MESSAGE,
        reason: 'gamepass_route_disabled'
      });
    }

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
          + 'Хэдэн өдрийн дараа өөр аргаар автоматаар хүргэх боломжтой болно.',
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

      // Checked live, right before the pass exists: the buyer may have
      // flipped the experience back to private since the storefront last
      // asked. Fails closed — see services/experience-readiness.js.
      let readiness;
      try {
        readiness = await this.checkExperience(normalizedUniverseId, req.session.robloxAccessToken);
      } catch (error) {
        console.error('Experience readiness check failed:', error.response?.status || error.message);
        return res.status(502).json({
          success: false,
          error: 'Тоглоомын тохиргоог Roblox-оос шалгаж чадсангүй. Дахин оролдоно уу.',
          reason: 'readiness_check_failed'
        });
      }
      if (!readiness.ready) {
        return res.status(409).json({
          success: false,
          error: readinessMessage(readiness),
          reason: 'experience_not_ready',
          readiness: GamePassController.publicReadiness(normalizedUniverseId, readiness)
        });
      }

      const quote = await this.quotePackage(req.session.userId, packageId);
      const { desiredRobux, deliveredRobux, terms, referralBonusRobux } = quote;
      const listedPrice = Math.ceil(deliveredRobux / SELLER_PAYOUT_RATE);

      // Reference first: the pass is named after it, so it has to exist
      // before we call Roblox. A reference burned by a later failure costs
      // nothing — they're random and there is no sequence to keep gapless.
      const paymentReference = await generateUniqueReference(this.dbHelpers);
      const { name, description } = GAME_PASS_IDENTITY;
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
          banks: await this.getBankDetails()
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
        return res.status(503).json({
          success: false,
          error: 'Үйлчилгээ түр хугацаанд боломжгүй байна. Дэмжлэгтэй холбогдоно уу.'
        });
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
          // Neither branch names the delivery route. What the buyer can act on
          // is the wait, so the wait is all they are told.
          error: eligibility.isMember
            ? `Таны аккаунт бэлэн болоход ${eligibility.daysRemaining} хоног үлдлээ.`
            : `Таны аккаунт хараахан бэлэн болоогүй байна. ${eligibility.requiredDays} хоногийн дараа захиалга үүсгэх боломжтой болно.`,
          reason: eligibility.reason,
          // Only the countdown crosses the wire. joinedAt, the membership
          // source and the group id stay on this side of it.
          eligibility: {
            requiredDays: eligibility.requiredDays,
            daysRemaining: eligibility.daysRemaining
          },
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
          banks: await this.getBankDetails()
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

  // The route for everyone neither automatic route can serve — see
  // services/manual-route.js. Priced and referenced exactly like a group
  // order; the difference is that an admin delivers it from a Messenger chat.
  async createManualOrder(req, res) {
    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'Эхлээд Roblox аккаунтаа холбоно уу.' });
    }

    const packageId = Number(req.body.packageId);
    if (!Number.isInteger(packageId)) {
      return res.status(400).json({ success: false, error: 'Robux багцаа сонгоно уу.' });
    }

    // Refused before anything is written: an order whose only way forward is
    // a chat link we cannot hand out is a paid order nobody will ever see.
    const messenger = messengerUrl();
    if (!messenger) {
      console.error('Manual order refused: MESSENGER_URL is missing or not a Messenger link.');
      return res.status(503).json({ success: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE });
    }

    try {
      await ensurePhoneLinked(this.dbHelpers, req.session.userId);

      const existing = await this.getActiveOrderForUser(req.session.userId);
      if (existing) {
        return this.respondWithExistingOrder(res, existing);
      }

      const quote = await this.quotePackage(req.session.userId, packageId);
      const { desiredRobux, deliveredRobux, terms, referralBonusRobux } = quote;
      const paymentReference = await generateUniqueReference(this.dbHelpers);

      const order = await new Promise((resolve, reject) => {
        this.dbHelpers.createManualOrder(
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
          banks: await this.getBankDetails()
        }),
        message: 'Захиалга үүслээ. Messenger-ээр бидэнд кодоо илгээнэ үү.',
        deliveryMethod: 'manual',
        messengerUrl: messenger
      });
    } catch (error) {
      if (error.code === 'PHONE_NOT_LINKED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      if (error.code === 'PACKAGE_NOT_FOUND') {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('Create manual order error:', error.response?.data || error.message);
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
