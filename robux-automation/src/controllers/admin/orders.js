// The order queue: reviewing payment, fulfilling, and resolving deliveries that stalled.
const RobloxGroup = require('../../services/roblox-group');
const { attemptGroupDelivery } = require('../../services/group-delivery');
const { ORDER_STATUS } = require('../../services/order-status');
const { statusLabel } = require('../../services/order-status');
const orders = require('../../services/orders');
const { ACTIONS, recordAdminAction } = require('../../services/audit');

module.exports = {
  async getOrders(req, res) {
    try {
      const orders = await new Promise((resolve, reject) => {
        this.dbHelpers.getGamePassOrders((error, rows) => {
          if (error) reject(error);
          else resolve(rows);
        });
      });

      res.json({
        success: true,
        orders: orders.map((order) => ({
          ...order,
          purchaseUrl: order.delivery_method === 'group'
            ? null
            : `https://www.roblox.com/game-pass/${order.roblox_gamepass_id}`
        }))
      });
    } catch (error) {
      console.error('Get purchase orders error:', error);
      res.status(500).json({ success: false, error: 'Захиалгын дарааллыг авч чадсангүй.' });
    }
  },

  async markOrderPurchased(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }
      if (order.status !== ORDER_STATUS.FULFILLMENT_PENDING) {
        return res.status(409).json({
          success: false,
          error: `Захиалга авахад бэлэн төлөвт биш байна (одоо: ${statusLabel(order.status)}).`
        });
      }

      if (order.delivery_method === 'group') {
        return this.checkGroupDelivery(req, res);
      }

      // Same lock the group route uses: claim the order before the
      // verification call so two admins clicking at once can't both complete
      // it. Verification is read-only, so a failure here safely releases.
      const claimed = await orders.claimForFulfillment(this.dbHelpers, orderId);
      if (!claimed) {
        return res.status(409).json({
          success: false,
          error: 'Энэ захиалгыг өөр админ боловсруулж байна.'
        });
      }

      let verification;
      try {
        verification = await this.RobloxAuth.verifySellerOwnsGamePass(order.roblox_gamepass_id);
      } catch (verifyError) {
        await orders.releaseFulfillmentClaim(this.dbHelpers, orderId, verifyError.message);
        throw verifyError;
      }

      if (!verification.owned) {
        await orders.releaseFulfillmentClaim(this.dbHelpers, orderId, null);
        return res.status(409).json({
          success: false,
          error: 'Seller аккаунт энэ Game Pass-ийг хараахан эзэмшээгүй байна.'
        });
      }

      await orders.markCompleted(this.dbHelpers, orderId);

      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_FULFILLED, {
        entityType: 'order',
        entityId: orderId,
        details: {
          route: 'gamepass',
          gamePassId: order.roblox_gamepass_id,
          deliveredRobux: order.delivered_robux || order.price,
          verifiedVia: 'inventory_api',
          sellerUserId: verification.sellerUserId
        }
      });

      res.json({
        success: true,
        message: 'Roblox inventory баталгаажлаа. Захиалга дууссан.',
        sellerUserId: verification.sellerUserId
      });
    } catch (error) {
      if (error.code !== 'ROBLOX_INVENTORY_NOT_CONFIGURED') {
        console.error('Verify purchase order error:', error.response?.data || error);
      }
      res.status(error.code === 'ROBLOX_INVENTORY_NOT_CONFIGURED' ? 503 : 502).json({
        success: false,
        error: error.code === 'ROBLOX_INVENTORY_NOT_CONFIGURED'
          ? error.message
          : 'Roblox inventory шалгаж чадсангүй. Дахин оролдоно уу.'
      });
    }
  },

  async markOrderPaymentReceived(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    try {
      // Approval and readiness-to-deliver are two distinct states, so an
      // approved order is durably recorded as approved even if resolving the
      // fulfillment route below fails.
      const approved = await orders.markPaymentApproved(this.dbHelpers, orderId, req.session?.adminId);
      if (!approved) {
        return res.status(409).json({
          success: false,
          error: 'Шалгагдахаар хүлээж буй захиалга олдсонгүй. Хэрэглэгч баримтаа илгээсэн эсэхийг шалгана уу.'
        });
      }
      await orders.markFulfillmentPending(this.dbHelpers, orderId);

      const order = await orders.getOrder(this.dbHelpers, orderId);

      // The single most important line in the log: a human decided this
      // payment was real, and everything downstream follows from it.
      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_PAYMENT_APPROVED, {
        entityType: 'order',
        entityId: orderId,
        details: {
          amountMnt: order?.amount_mnt,
          paymentReference: order?.payment_reference,
          deliveryMethod: order?.delivery_method
        }
      });

      if (order?.delivery_method === 'group') {
        // Try right away in case the buyer already sent their join request;
        // the background poller will keep retrying otherwise.
        try {
          const outcome = await attemptGroupDelivery(this.dbHelpers, orderId);
          const waiting = outcome.reason === 'membership_too_new' && outcome.eligibility
            ? `Төлбөрийг баталгаажууллаа. Хэрэглэгчийн группын гишүүнчлэл ${outcome.eligibility.daysRemaining} хоногийн дараа болно.`
            : 'Төлбөрийг баталгаажууллаа. Хэрэглэгч группд нэгдэх хүсэлт илгээхийг хүлээж байна.';
          return res.json({
            success: true,
            message: outcome.delivered
              ? 'Төлбөр баталгаажлаа. Групп payout шууд илгээгдлээ.'
              : waiting
          });
        } catch (deliveryError) {
          console.error('Immediate group delivery error:', deliveryError.response?.data || deliveryError);
          return res.json({
            success: true,
            message: 'Төлбөрийг баталгаажууллаа. Групп автоматжуулалт тохируулагдмагц ажиллана.'
          });
        }
      }

      res.json({ success: true, message: 'Төлбөрийг баталгаажууллаа. Game Pass авахад бэлэн.' });
    } catch (error) {
      console.error('Mark order payment error:', error);
      res.status(500).json({ success: false, error: 'Төлбөрийн төлөв шинэчлэгдсэнгүй.' });
    }
  },

  // Marks that an admin has opened this receipt. Advisory: approve and reject
  // both accept PAYMENT_SUBMITTED as well, so two admins working the queue at
  // once never deadlock each other — this just makes the queue readable.
  async markOrderUnderReview(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    try {
      const moved = await orders.markUnderReview(this.dbHelpers, orderId, req.session?.adminId);
      if (!moved) {
        return res.status(409).json({
          success: false,
          error: 'Энэ захиалга шалгах хүлээлгийн төлөвт биш байна.'
        });
      }
      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_UNDER_REVIEW, {
        entityType: 'order',
        entityId: orderId
      });

      res.json({ success: true, message: 'Захиалгыг шалгаж эхэллээ.' });
    } catch (error) {
      console.error('Mark order under review error:', error);
      res.status(500).json({ success: false, error: 'Захиалгын төлөв шинэчлэгдсэнгүй.' });
    }
  },

  // Rejects a submitted payment with a reason the buyer will see. This is not
  // terminal: the order drops back to a state where a corrected receipt can be
  // uploaded against it, so a blurry photo doesn't force a whole new order
  // (and a whole new reference code) on the buyer.
  async rejectOrderPayment(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }

    const reason = String(req.body.reason || '').trim();
    if (reason.length < 4 || reason.length > 300) {
      return res.status(400).json({
        success: false,
        error: 'Татгалзсан шалтгааныг 4-300 тэмдэгтээр бичнэ үү.'
      });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }

      const moved = await orders.markPaymentRejected(
        this.dbHelpers, orderId, req.session?.adminId, reason
      );
      if (!moved) {
        return res.status(409).json({
          success: false,
          error: `Энэ захиалгыг татгалзах боломжгүй (одоо: ${statusLabel(order.status)}).`
        });
      }

      await recordAdminAction(this.dbHelpers, req, ACTIONS.ORDER_PAYMENT_REJECTED, {
        entityType: 'order',
        entityId: orderId,
        details: {
          reason,
          amountMnt: order.amount_mnt,
          paymentReference: order.payment_reference
        }
      });

      res.json({
        success: true,
        message: 'Төлбөрийг татгалзлаа. Хэрэглэгч шинэ баримт илгээх боломжтой.'
      });
    } catch (error) {
      console.error('Reject order payment error:', error);
      res.status(500).json({ success: false, error: 'Татгалзах үйлдэл амжилтгүй боллоо.' });
    }
  },

  // GET /admin/orders/stalled — orders stuck mid-delivery.
  //
  // These are the only orders the system will not resolve on its own. Each
  // one had a payout request issued that we never saw a result for, so the
  // question "did the Robux actually arrive?" can only be answered by looking
  // at the group's payout history on Roblox.
  async getStalledOrders(req, res) {
    try {
      const stalled = await new Promise((resolve, reject) => {
        this.dbHelpers.getStalledFulfillments(1, (error, rows) => (error ? reject(error) : resolve(rows)));
      });

      // Rather than sending the admin off to Roblox to read the payout
      // history by hand, read it here and match each stalled order against
      // it. One API call for the whole queue, and the answer arrives in the
      // same view as the buttons that act on it.
      //
      // This is evidence, not a decision: robloxSaysDelivered is surfaced to
      // inform the admin's choice, and resolveStalledOrder still requires
      // them to state an outcome explicitly. Auto-resolving on a ledger match
      // would put a double payout one API quirk away.
      let ledger = null;
      if (stalled.some((order) => order.delivery_method === 'group')) {
        const [groupId, bot] = await Promise.all([
          this.getSettingValue('group_id'),
          new Promise((resolve, reject) => {
            this.dbHelpers.getActiveSellerBot((error, row) => (error ? reject(error) : resolve(row)));
          })
        ]);
        if (groupId && bot?.cookie) {
          ledger = await RobloxGroup.getRecentPayouts(groupId, bot.cookie);
        }
      }

      res.json({
        success: true,
        // Tells the dashboard whether to trust the per-order verdicts below
        // or tell the admin to go and look for themselves.
        payoutHistoryAvailable: ledger !== null,
        orders: stalled.map((order) => {
          const amountRobux = order.delivered_robux || order.price;
          return {
            id: order.id,
            username: order.username,
            robloxId: order.roblox_id,
            deliveryMethod: order.delivery_method,
            amountRobux,
            amountMnt: order.amount_mnt,
            paymentReference: order.payment_reference,
            startedAt: order.fulfillment_started_at,
            error: order.fulfillment_error,
            // true = Roblox's ledger shows it; false = it does not;
            // null = we could not read the ledger, so decide by hand.
            robloxSaysDelivered: order.delivery_method === 'group'
              ? RobloxGroup.matchPayout(ledger, order.roblox_id, amountRobux)
              : null
          };
        })
      });
    } catch (error) {
      console.error('Get stalled orders error:', error);
      res.status(500).json({ success: false, error: 'Гацсан захиалгуудыг авч чадсангүй.' });
    }
  },

  // Resolves a stuck order once an admin has checked Roblox and knows what
  // actually happened. Requires an explicit outcome — there is deliberately
  // no "just try again" button, because retrying a payout that already landed
  // is the exact failure this whole mechanism exists to prevent.
  //
  //   outcome=delivered — the payout is visible on Roblox; close as completed.
  //   outcome=not_delivered — nothing arrived; return the order to the queue
  //                           so the poller can legitimately retry it.
  //   outcome=failed — give up and mark it failed for manual refund.
  async resolveStalledOrder(req, res) {
    const orderId = Number(req.params.id);
    const outcome = String(req.body.outcome || '');
    const note = String(req.body.note || '').trim().slice(0, 300);

    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }
    if (!['delivered', 'not_delivered', 'failed'].includes(outcome)) {
      return res.status(400).json({
        success: false,
        error: 'Roblox дээрх бодит үр дүнг сонгоно уу (хүргэгдсэн / хүргэгдээгүй / амжилтгүй).'
      });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }
      if (order.status !== ORDER_STATUS.FULFILLMENT_PROCESSING) {
        return res.status(409).json({
          success: false,
          error: `Энэ захиалга гацаагүй байна (одоо: ${statusLabel(order.status)}).`
        });
      }

      let moved;
      let message;
      if (outcome === 'delivered') {
        moved = await orders.markCompleted(this.dbHelpers, orderId);
        message = 'Захиалгыг хүргэгдсэн гэж бүртгэлээ.';
      } else if (outcome === 'not_delivered') {
        moved = await orders.releaseFulfillmentClaim(this.dbHelpers, orderId, note || null);
        message = 'Захиалгыг дараалалд буцаалаа. Автоматаар дахин оролдоно.';
      } else {
        moved = await orders.markFailed(this.dbHelpers, orderId, note || 'Админ амжилтгүй гэж бүртгэв.');
        message = 'Захиалгыг амжилтгүй гэж бүртгэлээ. Төлбөрийг буцаана уу.';
      }

      if (!moved) {
        return res.status(409).json({ success: false, error: 'Захиалгын төлөв өөрчлөгдсөн байна.' });
      }

      // The admin's stated finding is the justification for whatever happens
      // to this order next, so it's recorded verbatim.
      await recordAdminAction(
        this.dbHelpers,
        req,
        outcome === 'failed' ? ACTIONS.ORDER_MARKED_FAILED : ACTIONS.ORDER_FULFILLED,
        {
          entityType: 'order',
          entityId: orderId,
          details: {
            resolution: outcome,
            note: note || null,
            manualResolution: true,
            previousError: order.fulfillment_error
          }
        }
      );

      res.json({ success: true, message });
    } catch (error) {
      console.error('Resolve stalled order error:', error);
      res.status(500).json({ success: false, error: 'Захиалгыг шийдвэрлэж чадсангүй.' });
    }
  },

  async checkGroupDelivery(req, res) {
    const orderId = Number(req.params.id);
    try {
      const outcome = await attemptGroupDelivery(this.dbHelpers, orderId);
      if (!outcome.delivered) {
        // "Not yet" is the expected answer for most of a group order's life —
        // say which wait it's in, since they resolve very differently.
        const messages = {
          awaiting_join: 'Хэрэглэгч группд нэгдэх хүсэлт хараахан илгээгээгүй байна.',
          membership_too_new: outcome.eligibility
            ? `Хэрэглэгч группд элссэн боловч ${outcome.eligibility.requiredDays} хоног болоогүй байна. Үлдсэн: ${outcome.eligibility.daysRemaining} хоног.`
            : 'Хэрэглэгчийн группын гишүүнчлэл хараахан болоогүй байна.',
          already_processing: 'Энэ захиалгыг өөр процесс боловсруулж байна.'
        };
        return res.status(409).json({
          success: false,
          error: messages[outcome.reason] || 'Хүргэлт хараахан боломжгүй байна.',
          reason: outcome.reason,
          eligibility: outcome.eligibility || null
        });
      }
      res.json({ success: true, message: 'Группын payout илгээгдлээ. Захиалга дууссан.' });
    } catch (error) {
      const knownCode = ['ORDER_NOT_FOUND', 'WRONG_METHOD', 'WRONG_STATUS', 'GROUP_NOT_CONFIGURED'].includes(error.code);
      if (!knownCode) console.error('Group delivery error:', error.response?.data || error);
      res.status(knownCode ? 409 : 502).json({
        success: false,
        error: knownCode ? error.message : 'Групп payout илгээж чадсангүй. Дахин оролдоно уу.'
      });
    }
  }
};
