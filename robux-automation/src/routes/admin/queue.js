// The work queue: reviewing payments, confirming deliveries, and the records
// that explain both.

module.exports = function registerAdminQueueRoutes(app, controllers, { requireAdminAuth }) {
  const { adminController, receiptController, paymentController } = controllers;

  // ---- Orders --------------------------------------------------------------

  app.get('/admin/orders', requireAdminAuth, adminController.getOrders.bind(adminController));

  // Sales totals. Ahead of /admin/orders/:id for the same reason as
  // /admin/orders/stalled below — a literal path must not be read as an id.
  app.get('/admin/orders/stats', requireAdminAuth, adminController.getOrderStats.bind(adminController));

  // The same sales, filtered by date range and free-text search. Read-only,
  // and literal for the same reason as the two paths around it.
  app.get('/admin/orders/sales', requireAdminAuth, adminController.getSalesSearch.bind(adminController));

  // Orders stuck mid-delivery. These are never retried automatically — an
  // admin has to check Roblox and state what actually happened, because a
  // payout that already landed must not be sent twice.
  //
  // Registered ahead of the /admin/orders/:id routes so the literal path is
  // matched first no matter what is added below it later.
  app.get('/admin/orders/stalled', requireAdminAuth, adminController.getStalledOrders.bind(adminController));
  app.post('/admin/orders/:id/resolve', requireAdminAuth, adminController.resolveStalledOrder.bind(adminController));

  app.put(
    '/admin/orders/:id/under-review',
    requireAdminAuth,
    adminController.markOrderUnderReview.bind(adminController)
  );
  app.put(
    '/admin/orders/:id/payment-received',
    requireAdminAuth,
    adminController.markOrderPaymentReceived.bind(adminController)
  );
  app.put(
    '/admin/orders/:id/purchased',
    requireAdminAuth,
    adminController.markOrderPurchased.bind(adminController)
  );

  // Rejection carries a reason in the body, so it's a POST rather than a PUT
  // alongside the other status flips.
  app.post(
    '/admin/orders/:id/reject',
    requireAdminAuth,
    adminController.rejectOrderPayment.bind(adminController)
  );

  // ---- Evidence ------------------------------------------------------------

  // Receipt review. Both routes are admin-gated: the files sit outside the
  // static root precisely so they can only be read through here.
  app.get(
    '/admin/receipts/:entityType(order|gift_card)/:entityId',
    requireAdminAuth,
    receiptController.listForEntity.bind(receiptController)
  );
  app.get('/admin/receipts/:id', requireAdminAuth, receiptController.serve.bind(receiptController));

  // Every confirmation the gateway has sent, applied or rejected. The first
  // place to look when a customer says they paid and nothing arrived.
  app.get('/admin/payments', requireAdminAuth, paymentController.listPayments.bind(paymentController));

  // Append-only audit trail. Read-only by design — there is deliberately no
  // route that edits or deletes an entry.
  app.get('/admin/audit-log', requireAdminAuth, adminController.getAuditLog.bind(adminController));
};
