// Placing an order and paying for it.

const { noStore, writeLimiter } = require('../middleware/anti-scraping');
const { receiptUpload } = require('../controllers/receipt-controller');
const { requireAuth } = require('./guards');

module.exports = function registerOrderRoutes(app, controllers) {
  const {
    gamepassController, transactionController, receiptController, paymentController
  } = controllers;

  // Two delivery routes, one per fulfilment method. Which one a buyer may use
  // is decided by /order/eligibility, and re-checked server-side here.
  app.post('/create-gamepass', writeLimiter, requireAuth, gamepassController.createGamePass.bind(gamepassController));
  app.post('/create-group-order', writeLimiter, requireAuth, gamepassController.createGroupOrder.bind(gamepassController));

  app.get('/gamepasses', requireAuth, gamepassController.getUserGamePasses.bind(gamepassController));
  app.get('/transactions', requireAuth, transactionController.getUserTransactions.bind(transactionController));

  // Buyer attaches proof of their bank transfer. receiptUpload parses the
  // multipart body and rejects oversized/unsupported files before the
  // controller sees them.
  app.post(
    '/orders/:id/receipt',
    writeLimiter,
    requireAuth,
    receiptUpload,
    receiptController.submitForOrder.bind(receiptController)
  );

  // Mint the QR the buyer scans in their banking app.
  app.post(
    '/orders/:id/qpay-invoice',
    writeLimiter,
    requireAuth,
    noStore,
    paymentController.createOrderInvoice.bind(paymentController)
  );
};
