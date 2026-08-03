// The payment gateway's callback.
//
// In its own file because it is the only route on this server that is
// deliberately unauthenticated *and* moves money, and that deserves to be
// impossible to miss.

const { writeLimiter } = require('../middleware/anti-scraping');

module.exports = function registerPaymentRoutes(app, { paymentController }) {
  // Necessarily unauthenticated — QPay calls it, not a browser — which is
  // exactly why the handler verifies every payment against QPay's own API and
  // never credits on the strength of the request body.
  //
  // requireBrowserContext is deliberately NOT applied: this caller is a
  // server, and the anti-scraping checks would reject it.
  //
  // Rate-limited all the same, so an open endpoint can't be used to make this
  // server hammer QPay on someone else's behalf.
  app.all(
    '/payments/qpay/callback',
    writeLimiter,
    paymentController.handleQpayCallback.bind(paymentController)
  );
};
