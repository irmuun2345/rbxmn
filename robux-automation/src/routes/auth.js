// Connecting a Roblox account through the official OAuth flow.
//
// No password ever reaches this server: the QR and the authorisation link
// both point at Roblox, and the only thing that comes back here is a code
// Roblox itself issued.

const { noStore, writeLimiter } = require('../middleware/anti-scraping');

module.exports = function registerAuthRoutes(app, { authController }) {
  // Generate a QR code for authentication. Rate-limited because each call
  // costs an outbound Roblox OAuth request and a database row.
  app.get('/auth/qr', writeLimiter, noStore, authController.generateQRCode.bind(authController));

  // Check authentication status. The storefront polls this while the QR is on
  // screen, so it gets the general ceiling rather than the write limit.
  app.get('/auth/status/:sessionId', noStore, authController.checkAuthStatus.bind(authController));

  // Roblox redirects here after the user approves access.
  app.get('/auth/roblox/callback', authController.handleOAuthCallback.bind(authController));

  app.post('/logout', authController.logout.bind(authController));
};
