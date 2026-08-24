const qpay = require('../services/qpay');
const orders = require('../services/orders');
const { applyConfirmedPayment } = require('../services/payments');
const { attemptGroupDelivery } = require('../services/group-delivery');
const { describeDeliveryFailure } = require('../services/delivery-errors');
const { ORDER_STATUS } = require('../services/order-status');

class PaymentController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  // POST /orders/:id/qpay-invoice
  //
  // Creates the QR the buyer scans. Ownership is checked here for the usual
  // reason — an order id is a small integer, and without this anyone logged
  // in could mint an invoice against someone else's order.
  async createOrderInvoice(req, res) {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, error: 'Захиалгын ID буруу байна.' });
    }
    if (!qpay.isConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Автомат төлбөр одоогоор идэвхгүй байна. Банкны шилжүүлгээр төлнө үү.'
      });
    }

    try {
      const order = await orders.getOrder(this.dbHelpers, orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Захиалга олдсонгүй.' });
      }
      if (order.user_id !== req.session.userId) {
        return res.status(403).json({ success: false, error: 'Энэ захиалга танийх биш байна.' });
      }
      if (![ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.PAYMENT_REJECTED].includes(order.status)) {
        return res.status(409).json({
          success: false,
          error: 'Энэ захиалга төлбөр хүлээх төлөвт биш байна.'
        });
      }

      // The callback host is derived from the request rather than configured,
      // so the same code works in development and behind a real domain.
      const callbackUrl = `${req.protocol}://${req.get('host')}/payments/qpay/callback`;

      const invoice = await qpay.createInvoice({
        reference: order.payment_reference,
        amountMnt: order.amount_mnt,
        description: `RBX ${order.delivered_robux || order.price} R$`,
        callbackUrl
      });

      res.json({
        success: true,
        invoiceId: invoice.invoiceId,
        qrText: invoice.qrText,
        qrImage: invoice.qrImage,
        urls: invoice.urls,
        amountMnt: order.amount_mnt,
        paymentReference: order.payment_reference
      });
    } catch (error) {
      if (error.code === 'QPAY_NOT_CONFIGURED') {
        return res.status(503).json({ success: false, error: error.message });
      }
      console.error('Create QPay invoice error:', error.response?.data || error.message);
      res.status(502).json({ success: false, error: 'Төлбөрийн нэхэмжлэл үүсгэж чадсангүй.' });
    }
  }

  // GET|POST /payments/qpay/callback
  //
  // Unauthenticated by necessity — QPay calls it, not a logged-in browser.
  // That is exactly why nothing in the request body is believed: the only
  // thing taken from it is an opaque invoice id, which is then verified
  // against QPay's own API before a single Robux moves.
  //
  // Always answers 200 once the request is well-formed. A gateway that gets a
  // non-2xx retries, and retrying a callback we have already recorded is
  // pointless — the idempotency claim would refuse it anyway.
  async handleQpayCallback(req, res) {
    const invoiceId = String(
      req.query.qpay_payment_id
      || req.query.payment_id
      || req.query.object_id
      || req.body?.object_id
      || req.body?.payment_id
      || ''
    ).trim();

    if (!invoiceId) {
      return res.status(400).json({ success: false, error: 'Payment id required' });
    }

    try {
      const verified = await qpay.verifyPayment(invoiceId);
      if (!verified?.paid) {
        // QPay does not consider this paid. Nothing to do, and importantly
        // nothing is credited on the strength of the callback alone.
        console.warn(`QPay callback for ${invoiceId} did not verify as paid.`);
        return res.json({ success: true, applied: false, reason: 'NOT_PAID' });
      }

      const result = await applyConfirmedPayment(this.dbHelpers, {
        provider: 'qpay',
        providerPaymentId: verified.providerPaymentId,
        // The reference comes from QPay's record of the invoice we created,
        // not from the callback query string.
        reference: verified.reference || req.query.reference,
        amountMnt: verified.amountMnt
      });

      if (result.applied && result.entityType === 'order') {
        // Deliver immediately for a buyer who is already group-eligible.
        // Failure here is not a payment problem — the order is approved and
        // queued, and the poller will pick it up.
        try {
          await attemptGroupDelivery(this.dbHelpers, result.entityId);
        } catch (deliveryError) {
          if (deliveryError.code !== 'WRONG_METHOD' && deliveryError.code !== 'GROUP_NOT_CONFIGURED') {
            const failure = describeDeliveryFailure(deliveryError);
            console.error(
              `Immediate delivery after QPay payment for order #${result.entityId} `
              + `[${failure.action}]: ${failure.message}`
            );
          }
        }
      }

      res.json({ success: true, applied: result.applied, reason: result.reason });
    } catch (error) {
      console.error('QPay callback error:', error.response?.data || error.message);
      // 502 rather than 500: the failure is upstream, and QPay retrying a
      // verification that timed out is genuinely useful.
      res.status(502).json({ success: false, error: 'Payment verification failed' });
    }
  }

  // GET /admin/payments — what the gateway has sent, applied or not.
  async listPayments(req, res) {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    try {
      const payments = await new Promise((resolve, reject) => {
        this.dbHelpers.getPayments(limit, (error, rows) => (error ? reject(error) : resolve(rows)));
      });
      res.json({ success: true, payments });
    } catch (error) {
      console.error('List payments error:', error);
      res.status(500).json({ success: false, error: 'Төлбөрийн бүртгэлийг авч чадсангүй.' });
    }
  }
}

module.exports = PaymentController;
