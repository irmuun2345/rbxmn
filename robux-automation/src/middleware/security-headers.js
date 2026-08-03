const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');

const isProduction = () => process.env.NODE_ENV === 'production';

// A fresh nonce per response. This is what lets the Content-Security-Policy
// below refuse *all* inline script except the blocks this server itself
// stamped — an injected <script> can't guess the value, so a stored-XSS bug
// anywhere in the admin dashboard stops being exploitable.
function cspNonce(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}

const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No 'unsafe-inline' fallback: browsers that understand nonces ignore
      // it anyway, and leaving it out means the policy fails closed.
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      // Google Fonts serves the @font-face rules as a stylesheet from
      // googleapis and the font files themselves from gstatic. The nonce
      // covers the one inline <style> the app emits — the OAuth result page,
      // which is generated in the controller rather than served from public/.
      // Unlike script-src, a nonce here doesn't invalidate the host
      // allowlist, so fonts.googleapis.com still loads.
      styleSrc: ["'self'", 'https://fonts.googleapis.com', (req, res) => `'nonce-${res.locals.cspNonce}'`],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // data: covers the Roblox OAuth QR code, which the qrcode package
      // renders straight into a data URI.
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      // Clickjacking: nothing may frame the storefront or the dashboard.
      frameAncestors: ["'none'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      ...(isProduction() ? { upgradeInsecureRequests: [] } : {})
    }
  },
  // Referrer would otherwise leak order ids and payment references to any
  // outbound link (the Roblox group links on the storefront).
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  // Only meaningful over HTTPS; sending it in development would poison
  // localhost for every other project on the machine.
  hsts: isProduction()
    ? { maxAge: 63072000, includeSubDomains: true, preload: true }
    : false
});

// Features this site never uses. Denying them means a compromised page can't
// silently reach for a camera or a location fix.
function permissionsPolicy(req, res, next) {
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), interest-cohort=()'
  );
  next();
}

// ---------------------------------------------------------------------------
// HTML delivery
// ---------------------------------------------------------------------------

// express.static can't rewrite what it serves, so the three HTML pages are
// served from here instead: read once, cached by mtime, with the per-response
// nonce stamped into every inline <script> on the way out. Everything else
// (CSS, JS, the favicon) still goes through express.static untouched.
function nonceStampedHtml(publicDir) {
  const root = path.resolve(publicDir);
  const cache = new Map();

  function load(filePath, callback) {
    fs.stat(filePath, (statError, stats) => {
      if (statError || !stats.isFile()) return callback(statError || new Error('ENOTFILE'));

      const cached = cache.get(filePath);
      if (cached && cached.mtimeMs === stats.mtimeMs) return callback(null, cached.html);

      fs.readFile(filePath, 'utf8', (readError, html) => {
        if (readError) return callback(readError);
        cache.set(filePath, { mtimeMs: stats.mtimeMs, html });
        callback(null, html);
      });
    });
  }

  return function serveHtml(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // "/" and extensionless "/admin" both resolve to their .html file, so the
    // pages keep working at the URLs the existing links already point at.
    let relative = req.path === '/' ? '/index.html' : req.path;
    if (!path.extname(relative)) relative = `${relative}.html`;
    if (!relative.endsWith('.html')) return next();

    const filePath = path.resolve(root, `.${relative}`);
    // Normalising above already collapses "..", but re-check the prefix so a
    // crafted path can never read outside public/.
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return next();

    load(filePath, (error, html) => {
      // Missing file falls through to static and then to the 404 handler.
      if (error) return next();

      const nonce = res.locals.cspNonce;
      const stamped = html.replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);

      res.type('html');
      // The pages are personalised by session, so they must not be held in a
      // shared cache — but they change rarely, so revalidation is enough.
      res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
      res.send(stamped);
    });
  };
}

module.exports = { cspNonce, securityHeaders, permissionsPolicy, nonceStampedHtml };
