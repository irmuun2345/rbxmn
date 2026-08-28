const { ensurePhoneLinked } = require('./phone-controller');
const { getUserLevelDiscountPercent } = require('../services/pricing');
const { attemptGroupDelivery } = require('../services/group-delivery');
const { ORDER_STATUS } = require('../services/order-status');
const orders = require('../services/orders');
const { generateUniqueReference, randomSuffix } = require('../services/payment-reference');
const { ACTIONS, recordUserAction } = require('../services/audit');

function randomCode(prefix, length) {
  return `${prefix}-${randomSuffix(length)}`;
}

// A gift card is no longer bought off the fixed package shelf — the buyer
// types the amount they want to give. These bounds are the whole of the
// rule: low enough that a mistyped digit cannot mint a card nobody would
// transfer for, high enough to be worth sending.
const MIN_GIFT_ROBUX = 100;
const MAX_GIFT_ROBUX = 1000;
const DEFAULT_PRICE_PER_100 = 4500;

class GiftCardController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  getSettingValue(key) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getSetting(key, (error, row) => (error ? reject(error) : resolve(row?.value || '')));
    });
  }

  // Buy a gift card for any amount between MIN_GIFT_ROBUX and MAX_GIFT_ROBUX,
  // priced off the live rate rather than a package row: what a present is
  // worth is the giver's decision, not a shelf they pick from. The buyer's
  // own level discount still applies, exactly as on a normal order.
  //
  // Paid the same way (bank transfer), just held as an unredeemed code
  // instead of delivered straight away. Admin approves the payment exactly
  // like a normal order; only then does the code become redeemable.
  async create(req, res) {
    // The amount is the only thing taken from the client, and the price is
    // never taken from it at all — what the storefront showed was a preview,
    // recomputed below from settings the buyer cannot reach.
    const robuxAmount = Number(req.body.robuxAmount);
    if (!Number.isInteger(robuxAmount) || robuxAmount < MIN_GIFT_ROBUX || robuxAmount > MAX_GIFT_ROBUX) {
      return res.status(400).json({
        success: false,
        error: `Бэлгийн картын дүн ${MIN_GIFT_ROBUX}-аас ${MAX_GIFT_ROBUX} Robux хооронд бүхэл тоо байх ёстой.`
      });
    }

    try {
      await ensurePhoneLinked(this.dbHelpers, req.session.userId);

      const [rate, levelDiscountPercent] = await Promise.all([
        this.getSettingValue('price_per_100_robux_mnt'),
        getUserLevelDiscountPercent(this.dbHelpers, req.session.userId)
      ]);
      const pricePer100 = Number(rate) || DEFAULT_PRICE_PER_100;

      // No event or referral bonus: a gift card was never eligible for one
      // (priceForPackage was called with both at zero), and the amount the
      // giver paid for is the amount the recipient gets.
      const deliveredRobux = robuxAmount;
      const amountMnt = Math.round((robuxAmount / 100) * pricePer100 * (1 - levelDiscountPercent / 100));
      const code = randomCode('GIFT', 8);
      const paymentReference = await generateUniqueReference(this.dbHelpers);

      const giftCard = await new Promise((resolve, reject) => {
        this.dbHelpers.createGiftCard(
          code, deliveredRobux, amountMnt, paymentReference, req.session.userId,
          (error, row) => (error ? reject(error) : resolve(row))
        );
      });

      const banks = await new Promise((resolve, reject) => {
        this.dbHelpers.listActiveBankAccounts((error, rows) => (error ? reject(error) : resolve(rows)));
      });

      res.json({
        success: true,
        message: 'Бэлгийн картын захиалга үүслээ. Төлбөр баталгаажсаны дараа код идэвхжинэ.',
        giftCardId: giftCard.id,
        robuxAmount: deliveredRobux,
        amountMnt,
        levelDiscountPercent,
        paymentReference,
        banks: banks.map((row) => ({
          id: row.id,
          name: row.bank_name,
          accountNumber: row.account_number,
          accountHolder: row.account_holder
        })),
        status: 'awaiting_payment'
      });
    } catch (error) {
      if (error.code === 'PHONE_NOT_LINKED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      console.error('Create gift card error:', error);
      res.status(500).json({ success: false, error: 'Бэлгийн карт үүсгэж чадсангүй. Дахин оролдоно уу.' });
    }
  }

  // The buyer's own gift cards — the code is only revealed once admin has
  // approved payment, so there's nothing to redeem with before that.
  async mine(req, res) {
    try {
      const giftCards = await new Promise((resolve, reject) => {
        this.dbHelpers.getGiftCardsByPurchaser(req.session.userId, (error, rows) => (error ? reject(error) : resolve(rows)));
      });
      res.json({
        success: true,
        giftCards: giftCards.map((card) => ({
          id: card.id,
          code: card.status === 'awaiting_payment' ? null : card.code,
          robuxAmount: card.robux_amount,
          amountMnt: card.price_mnt,
          paymentReference: card.payment_reference,
          status: card.status,
          rejectionReason: card.rejection_reason || null,
          createdAt: card.created_at
        }))
      });
    } catch (error) {
      console.error('Get my gift cards error:', error);
      res.status(500).json({ success: false, error: 'Бэлгийн картуудыг авч чадсангүй.' });
    }
  }

  // Redeem a code straight into the redeemer's OWN linked Roblox account —
  // there's no "recipient account" field, by design: "transferring" a gift
  // card just means handing someone the code, and whoever redeems it always
  // receives the Robux on their own phone-linked account, never someone
  // else's. That keeps a leveled-up buyer from using a gift card as a way
  // to top up other accounts at their own discount rate.
  async redeem(req, res) {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ success: false, error: 'Бэлгийн картын кодоо оруулна уу.' });
    }

    try {
      await ensurePhoneLinked(this.dbHelpers, req.session.userId);

      const giftCard = await new Promise((resolve, reject) => {
        this.dbHelpers.getGiftCardByCode(code, (error, row) => (error ? reject(error) : resolve(row)));
      });
      if (!giftCard) {
        return res.status(404).json({ success: false, error: 'Ийм код бүхий бэлгийн карт олдсонгүй.' });
      }
      if (giftCard.status === 'awaiting_payment') {
        return res.status(409).json({ success: false, error: 'Энэ бэлгийн картын төлбөр хараахан баталгаажаагүй байна.' });
      }
      if (giftCard.status === 'redeemed') {
        return res.status(409).json({ success: false, error: 'Энэ бэлгийн карт өмнө нь ашиглагдсан байна.' });
      }

      const groupId = await this.getSettingValue('group_id');
      if (!groupId) {
        return res.status(503).json({
          success: false,
          error: 'Үйлчилгээ түр хугацаанд боломжгүй байна. Дэмжлэгтэй холбогдоно уу.'
        });
      }

      // Roblox's group-join approval only satisfies one pending delivery at
      // a time, so a second concurrent group order (from redeeming while
      // another is still in flight) could get silently stuck. Same guard
      // normal order creation already uses.
      const existingOrder = await new Promise((resolve, reject) => {
        this.dbHelpers.getActiveOrderForUser(req.session.userId, (error, row) => (error ? reject(error) : resolve(row)));
      });
      if (existingOrder) {
        return res.status(409).json({
          success: false,
          error: 'Танд аль хэдийн боловсруулагдаж буй захиалга байна. Түүнийг дуусгаад дахин оролдоно уу.'
        });
      }

      // Claim the card BEFORE creating anything that could deliver Robux.
      //
      // The status check above is a courtesy that produces a good error
      // message; it is not the guard. A gift card code is made to be passed
      // around, so two people redeeming it at the same moment is ordinary —
      // and if both got past that read, both would previously have had a
      // delivery order created and paid out against a single purchase.
      //
      // This UPDATE is the guard: exactly one caller can move the card out of
      // 'approved', and only that caller goes on to create an order.
      const claim = await new Promise((resolve, reject) => {
        this.dbHelpers.claimGiftCardForRedemption(giftCard.id, req.session.userId, (error, result) => (
          error ? reject(error) : resolve(result)
        ));
      });
      if (!claim.changes) {
        return res.status(409).json({
          success: false,
          error: 'Энэ бэлгийн карт өмнө нь ашиглагдсан байна.'
        });
      }

      let order;
      try {
        order = await new Promise((resolve, reject) => {
          this.dbHelpers.createGroupOrder(
            req.session.userId,
            giftCard.robux_amount,
            giftCard.price_mnt,
            Math.round((giftCard.price_mnt / giftCard.robux_amount) * 100),
            `GIFT-${giftCard.id}`,
            giftCard.robux_amount,
            0,
            (error, result) => (error ? reject(error) : resolve(result))
          );
        });
      } catch (orderError) {
        // Nothing was delivered and no order exists, so the card must not
        // stay spent — hand it back rather than swallowing someone's purchase.
        await new Promise((resolve) => {
          this.dbHelpers.releaseGiftCardClaim(giftCard.id, () => resolve());
        });
        throw orderError;
      }

      await new Promise((resolve, reject) => {
        this.dbHelpers.attachGiftCardOrder(giftCard.id, order.id, (error, result) => (
          error ? reject(error) : resolve(result)
        ));
      });

      // A redeemed gift card was already paid for and approved when it was
      // bought, so its delivery order skips the whole payment leg and lands
      // straight in the fulfillment queue.
      await orders.transition(
        this.dbHelpers,
        order.id,
        [ORDER_STATUS.AWAITING_PAYMENT],
        ORDER_STATUS.PAYMENT_APPROVED,
        { reviewed_at: new Date().toISOString() }
      );
      await orders.markFulfillmentPending(this.dbHelpers, order.id);

      // A gift card can only ever be redeemed once, so this is the record of
      // which account consumed it.
      await recordUserAction(this.dbHelpers, req, ACTIONS.GIFT_CARD_REDEEMED, {
        entityType: 'gift_card',
        entityId: giftCard.id,
        details: {
          robuxAmount: giftCard.robux_amount,
          orderId: order.id,
          purchaserUserId: giftCard.purchaser_user_id
        }
      });

      let delivered = false;
      try {
        const outcome = await attemptGroupDelivery(this.dbHelpers, order.id);
        delivered = outcome.delivered;
      } catch (deliveryError) {
        console.error('Immediate gift card delivery error:', deliveryError.response?.data || deliveryError);
      }

      res.json({
        success: true,
        message: delivered
          ? 'Бэлгийн карт ашиглагдлаа. Robux шууд илгээгдлээ.'
          : 'Бэлгийн карт ашиглагдлаа. Аккаунт бэлэн болмогц Robux шилжинэ.',
        deliveredRobux: giftCard.robux_amount,
        groupId,
        groupUrl: `https://www.roblox.com/groups/${groupId}`,
        delivered
      });
    } catch (error) {
      if (error.code === 'PHONE_NOT_LINKED') {
        return res.status(403).json({ success: false, error: error.message });
      }
      console.error('Redeem gift card error:', error);
      res.status(500).json({ success: false, error: 'Бэлгийн картыг ашиглаж чадсангүй. Дахин оролдоно уу.' });
    }
  }
}

module.exports = GiftCardController;
