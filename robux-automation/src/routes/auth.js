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

  registerDevLogin(app, authController);
};

// A local shortcut past the Roblox round trip, for looking at the signed-in
// storefront while working on it.
//
// Roblox will not accept http://localhost as an OAuth redirect URL, so a
// developer running the app on their own machine has no way to reach any
// page behind a login. This is the way around that, and it exists for
// exactly that reason — not as a convenience for anything deployed.
//
// It is fenced by three separate conditions, all of which must hold:
//
//   NODE_ENV !== 'production'   a production build never registers the route
//   DATABASE_URL unset          so the only database it can touch is the
//                               in-process, in-memory PGlite one; it cannot
//                               reach Neon or any other real server
//   DEV_LOGIN === '1'           explicit opt-in, off by default even locally
//
// Any one of them failing means the route does not exist at all — not that
// it exists and refuses. There is nothing to disable at runtime and nothing
// to misconfigure into being reachable, which is the property worth having
// for a route that hands out a session for free.
function registerDevLogin(app, authController) {
  const enabled = process.env.NODE_ENV !== 'production'
    && !process.env.DATABASE_URL
    && process.env.DEV_LOGIN === '1';

  if (!enabled) return;

  console.warn(
    '\n  ⚠  DEV_LOGIN is on: GET /auth/dev-login signs in a fake local user '
    + 'with no password.\n     Local, in-memory database only. Never set DEV_LOGIN in a deployed '
    + 'environment.\n'
  );

  const { dbHelpers } = authController;
  const promisify = (method, ...args) => new Promise((resolve, reject) => {
    dbHelpers[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
  });

  app.get('/auth/dev-login', async (req, res) => {
    try {
      // A stable username and roblox id, so signing in twice returns to the
      // same account and whatever it did last time is still there.
      const username = process.env.DEV_LOGIN_USERNAME || 'DevTester';
      let user = await promisify('getUserByUsername', username);
      if (!user) {
        user = await promisify('createUser', username, 999000001);
      }

      // The same session handling the real callback performs: a new id at the
      // privilege change, and the session durably stored before the redirect
      // that relies on it.
      await new Promise((resolve, reject) => {
        req.session.regenerate((error) => (error ? reject(error) : resolve()));
      });

      req.session.userId = user.id;
      req.session.username = username;

      await new Promise((resolve, reject) => {
        req.session.save((error) => (error ? reject(error) : resolve()));
      });

      res.redirect('/');
    } catch (error) {
      console.error('Dev login failed:', error);
      res.status(500).json({ success: false, error: 'Dev login failed.' });
    }
  });
}
