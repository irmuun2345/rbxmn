// The access rules every route file draws from.
//
// Defined once so that "which routes are public" is a question with one
// answer, readable in one place, rather than a middleware array copy-pasted
// down a 400-line file.

const {
  requireBrowserContext,
  noStore,
  publicDataLimiter
} = require('../middleware/anti-scraping');

// A signed-in customer. Admin routes use requireAdminAuth instead — the two
// session flags are separate, so a customer session can never reach an admin
// route by accident.
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ success: false, error: 'Authentication required' });
}

// The public catalogue endpoints: readable without a login, which is exactly
// why they're the ones worth mirroring. This chain demands the request
// actually came from our own front end and caps how fast it can be asked for.
//
// Signed-in routes don't need it — a session is already a much higher bar
// than a forged User-Agent.
const publicData = [publicDataLimiter, requireBrowserContext, noStore];

// Paths whose responses are personalised by session. Applied as a prefix
// match so a shared cache never holds one user's orders where another can be
// handed them.
const PRIVATE_PATH_PREFIXES = [
  '/profile', '/gamepasses', '/transactions', '/gift-cards', '/admin'
];

module.exports = { requireAuth, publicData, PRIVATE_PATH_PREFIXES };
