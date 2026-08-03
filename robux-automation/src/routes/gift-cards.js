// Buying a gift card, and redeeming one.

const { codeLimiter, writeLimiter } = require('../middleware/anti-scraping');
const { receiptUpload } = require('../controllers/receipt-controller');
const { requireAuth } = require('./guards');

module.exports = function registerGiftCardRoutes(app, { giftCardController, receiptController }) {
  app.post('/create-gift-card', writeLimiter, requireAuth, giftCardController.create.bind(giftCardController));
  app.get('/gift-cards/mine', requireAuth, giftCardController.mine.bind(giftCardController));

  // Redemption takes a code, so it's the one endpoint here that can be
  // brute-forced. It gets the code limiter's tighter window, not the write
  // one.
  app.post('/gift-cards/redeem', codeLimiter, requireAuth, giftCardController.redeem.bind(giftCardController));

  app.post(
    '/gift-cards/:id/receipt',
    writeLimiter,
    requireAuth,
    receiptUpload,
    receiptController.submitForGiftCard.bind(receiptController)
  );
};
