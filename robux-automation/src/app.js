const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../config/.env') });

// Import middleware
const { requireAdminAuth, adminLogin, adminRegister } = require('./middleware/admin-auth');
const { cspNonce, securityHeaders, permissionsPolicy, nonceStampedHtml } = require('./middleware/security-headers');
const { SqliteSessionStore } = require('./middleware/session-store');
const { blockKnownScrapers, globalLimiter } = require('./middleware/anti-scraping');

// Import services
const RobloxAuth = require('./services/roblox-auth');

// Import models
const { dbHelpers } = require('./models/db');

const app = express();
// Get the port set by the server or default to 3003
const PORT = app.get('port') || process.env.PORT || 3003;

const isProduction = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, '../public');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// A hardcoded fallback secret is the same as no secret at all: it's in the
// source, so anyone who can read this file can forge an admin session cookie.
// In production the process refuses to start without a real one.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === 'replace-with-a-long-random-value') {
  if (isProduction) {
    console.error(
      'FATAL: SESSION_SECRET is not set. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
    process.exit(1);
  }
  console.warn('WARNING: SESSION_SECRET is unset — using a random per-restart secret (development only).');
}

// ---------------------------------------------------------------------------
// Proxy awareness
// ---------------------------------------------------------------------------

// Rate limiting and the audit log both key on req.ip. Behind a proxy without
// this, every request reports the proxy's address: the audit trail records
// one IP for everyone, and the first person to trip a limit locks out the
// whole site. Left off in development, where trusting XFF would let anyone
// spoof their own address.
if (isProduction) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
}

// Version disclosure — free reconnaissance for anyone fingerprinting the stack.
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Security middleware — first, so it covers every route including static
// ---------------------------------------------------------------------------

app.use(cspNonce);
app.use(securityHeaders);
app.use(permissionsPolicy);
app.use(blockKnownScrapers);
app.use(globalLimiter);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Explicit ceilings. Every JSON endpoint here takes a handful of fields, so
// anything larger is either a mistake or an attempt to tie up memory.
app.use(bodyParser.json({ limit: '64kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '64kb' }));
app.use(cookieParser());

// Session configuration with secure settings
app.use(session({
  name: 'rbx.sid',
  secret: SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  // Persistent store: the default MemoryStore leaks expired sessions and
  // drops everyone's login on restart.
  store: new SqliteSessionStore({ ttlMs: SESSION_TTL_MS }),
  // Slides the expiry on activity, so an admin working through the dashboard
  // isn't logged out mid-review at the 24-hour mark.
  rolling: true,
  cookie: {
    secure: isProduction, // Only use secure cookies in production
    httpOnly: true, // Prevent client-side access to cookies
    // Blocks the cookie from riding along on cross-site requests, which is
    // what makes CSRF against the admin endpoints impractical.
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS
  }
}));

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

// HTML goes through the nonce stamper; everything else through static.
// index:false stops static from serving index.html behind the stamper's back.
app.use(nonceStampedHtml(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR, {
  index: false,
  dotfiles: 'ignore',
  // Fingerprint-free filenames, so revalidate rather than cache hard.
  maxAge: isProduction ? '1h' : 0
}));

// Crawlers are told to stay out of everything but the storefront itself.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /admin.html',
    'Disallow: /admin-login.html',
    'Disallow: /auth/',
    'Disallow: /profile',
    'Disallow: /pricing',
    'Disallow: /packages',
    'Disallow: /events',
    'Disallow: /bank-account',
    'Disallow: /group-info',
    '',
    'User-agent: GPTBot',
    'Disallow: /',
    '',
    'User-agent: CCBot',
    'Disallow: /',
    '',
    'User-agent: ClaudeBot',
    'Disallow: /',
    '',
    'User-agent: Bytespider',
    'Disallow: /',
    ''
  ].join('\n'));
});

// Import routes
require('./routes')(app, {
  dbHelpers,
  RobloxAuth,
  requireAdminAuth,
  adminLogin,
  adminRegister
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

// Without these, an unmatched route returns express's HTML "Cannot GET /x"
// and a thrown error returns a stack trace — both of which tell an attacker
// about the stack, and neither of which the front end can parse.
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Хүсэлт олдсонгүй.' });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({
    success: false,
    error: 'Серверийн алдаа гарлаа.',
    // The real message only ever reaches a developer's own console.
    ...(isProduction ? {} : { detail: error.message })
  });
});

// Start server
// Note: The server is actually started in server.js, this is just for consistency
console.log(`Robux Automation Server configured for port ${PORT}`);

module.exports = app;
