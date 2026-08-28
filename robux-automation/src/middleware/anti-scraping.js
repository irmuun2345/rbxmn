const rateLimit = require('express-rate-limit');

// Scraping defence, in layers. No single one of these stops a determined
// operator — a headless Chrome driving a residential proxy pool looks exactly
// like a customer. What they do stop is the cheap majority: curl loops, the
// off-the-shelf scraping frameworks, and anyone hammering the pricing
// endpoint from one address to mirror the storefront.
//
// The rule the whole file follows: never block on a signal that a real
// customer could trip. Every check below either fails open or only fires on
// something a browser does not do.

// ---------------------------------------------------------------------------
// 1. Client identity
// ---------------------------------------------------------------------------

// Tools that announce themselves. Matched case-insensitively against the full
// UA string. Deliberately excludes search-engine crawlers — those are handled
// separately below, because the storefront wants to be indexed.
const SCRAPER_AGENTS = [
  'curl/', 'wget', 'python-requests', 'python-urllib', 'httpie', 'go-http-client',
  'java/', 'okhttp', 'apache-httpclient', 'libwww-perl', 'lwp::', 'php ',
  'guzzlehttp', 'axios/', 'node-fetch', 'got (', 'ruby', 'restsharp',
  'scrapy', 'httrack', 'wappalyzer', 'nikto', 'sqlmap', 'nmap', 'masscan',
  'zgrab', 'dirbuster', 'gobuster', 'ffuf', 'feroxbuster', 'nuclei',
  'headlesschrome', 'phantomjs', 'selenium', 'puppeteer', 'playwright',
  'crawler', 'spider', 'scraper', 'harvest', 'extractor'
];

// Crawlers that are allowed through to public pages so the site stays
// indexable. They still get the API restrictions below.
const ALLOWED_CRAWLERS = [
  'googlebot', 'bingbot', 'duckduckbot', 'yandexbot', 'baiduspider',
  'slurp', 'facebookexternalhit', 'twitterbot', 'linkedinbot',
  'telegrambot', 'whatsapp', 'discordbot', 'applebot'
];

function userAgentOf(req) {
  return String(req.get('user-agent') || '').toLowerCase();
}

function isAllowedCrawler(req) {
  const ua = userAgentOf(req);
  return ALLOWED_CRAWLERS.some((name) => ua.includes(name));
}

function isKnownScraper(req) {
  const ua = userAgentOf(req);
  if (!ua) return false;
  if (isAllowedCrawler(req)) return false;
  return SCRAPER_AGENTS.some((name) => ua.includes(name));
}

// A browser always sends a User-Agent. An empty or absurdly short one means
// something hand-rolled — unless the request also carries Fetch Metadata
// saying it came from our own page, which no hand-rolled client bothers
// with and which a stripping proxy usually leaves alone. That combination
// is a customer whose UA was scrubbed on the way out, so it is forgiven:
// refusing it would load the storefront and then leave it empty.
function hasImplausibleUserAgent(req) {
  const ua = userAgentOf(req);
  if (ua.length >= 12) return false;
  return req.get('sec-fetch-site') !== 'same-origin';
}

// ---------------------------------------------------------------------------
// 2. Request shape
// ---------------------------------------------------------------------------

// Fetch Metadata headers are sent by every current browser and cannot be set
// from page JavaScript, which makes them a genuinely useful signal rather
// than a guess. Absent (older browser, or a proxy that strips them) is
// treated as fine — this must fail open.
function violatesFetchMetadata(req) {
  const site = req.get('sec-fetch-site');
  if (!site) return false;
  return site !== 'same-origin' && site !== 'same-site' && site !== 'none';
}

// Origin/Referer check for the JSON API. A browser fetch() from our own page
// always carries one of them pointing at our host; a script pulling the
// endpoint directly usually carries neither.
function isForeignOrigin(req) {
  const host = req.get('host');
  if (!host) return false;

  const stated = req.get('origin') || req.get('referer');
  if (!stated) return false;

  try {
    return new URL(stated).host !== host;
  } catch {
    // Unparseable Origin/Referer is not something a browser produces.
    return true;
  }
}

// Does this request carry the headers only a real browser engine sends?
//
// Fetch Metadata is set by the browser itself and cannot be forged from page
// JavaScript, and an Accept naming text/html is what a navigation asks for.
// Neither is something curl or python-requests sends by default.
//
// This exists because the User-Agent is not ours to trust: antivirus HTTPS
// scanning, school and office proxies, and some VPN apps rewrite or strip it
// on the way through, and a customer behind one of those was being handed a
// 403 on the storefront itself. Header shape survives that; the UA does not.
function looksLikeBrowserRequest(req) {
  if (req.get('sec-fetch-dest') || req.get('sec-fetch-mode') || req.get('sec-fetch-site')) {
    return true;
  }
  return String(req.get('accept') || '').includes('text/html');
}

function denyScrape(res, reason) {
  return res.status(403).json({
    success: false,
    error: 'Хүсэлтийг боловсруулах боломжгүй байна.',
    code: reason
  });
}

// ---------------------------------------------------------------------------
// 3. Middleware
// ---------------------------------------------------------------------------

// Applied site-wide. Blocks self-identifying tooling before it reaches any
// route, static asset included — mirroring the HTML is the cheapest scrape
// there is.
//
// The User-Agent alone is not enough to refuse on here. A rewritten UA is
// something a real customer trips through no fault of their own, and the
// cost of a false positive at this layer is the whole storefront going dark
// for them. So a scraper UA is only refused when nothing else about the
// request looks like a browser either. Anything that gets through on that
// benefit of the doubt still meets the full check on the JSON API below,
// which is the half worth mirroring.
function blockKnownScrapers(req, res, next) {
  if (isKnownScraper(req) && !looksLikeBrowserRequest(req)) {
    return denyScrape(res, 'AUTOMATED_CLIENT');
  }
  next();
}

// Applied to the public JSON endpoints (pricing, packages, events, bank
// details). These are the ones worth mirroring — they are a competitor's
// price list — and unlike the HTML they have no reason to be read by anything
// but our own front end.
function requireBrowserContext(req, res, next) {
  // Held here rather than site-wide: headless Chrome and the scripted
  // browsers announce themselves in the UA, and letting them read the price
  // list is the one thing this file exists to prevent. On an HTML page the
  // same UA now passes, because there a false positive costs a customer.
  if (isKnownScraper(req)) {
    return denyScrape(res, 'AUTOMATED_CLIENT');
  }
  if (isAllowedCrawler(req)) {
    // A crawler has no business reading the JSON API. Refuse politely
    // instead of feeding it data it would then cache and republish.
    return denyScrape(res, 'CRAWLER_NOT_PERMITTED');
  }
  if (hasImplausibleUserAgent(req)) {
    return denyScrape(res, 'MISSING_CLIENT_IDENTITY');
  }
  if (violatesFetchMetadata(req)) {
    return denyScrape(res, 'CROSS_SITE_REQUEST');
  }
  if (isForeignOrigin(req)) {
    return denyScrape(res, 'FOREIGN_ORIGIN');
  }
  next();
}

// Priced data should never sit in a shared cache where it can be harvested
// without ever reaching this server.
function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}

// ---------------------------------------------------------------------------
// 4. Rate limits
// ---------------------------------------------------------------------------

// Rate limiting is the layer that actually costs a scraper something, because
// it is the only one that survives a perfectly-forged browser fingerprint.
// Keyed on IP, which requires `trust proxy` to be set correctly — otherwise
// every request behind a load balancer shares one key and the limiter locks
// out the whole site at once.

const limitResponse = (message) => (req, res) => res.status(429).json({
  success: false,
  error: message
});

// Site-wide ceiling. Generous enough that a customer browsing normally, with
// the storefront polling order status, never approaches it.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitResponse('Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.')
});

// The public data endpoints. A human loads these a handful of times per
// session; anything mirroring the catalogue hits them in a tight loop.
const publicDataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitResponse('Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.')
});

// Credential endpoints. Tight, and counts only failures so a legitimate admin
// working through the dashboard is never locked out by their own successful
// logins.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitResponse('Нэвтрэх оролдлого хэт олон удаа амжилтгүй боллоо. 15 минутын дараа дахин оролдоно уу.')
});

// Endpoints that take a secret code in the body and can therefore be guessed
// at: gift-card redemption, referral codes. Its own instance rather than
// reusing loginLimiter, so failed redemptions can't lock an admin out of the
// dashboard (each limiter keeps a separate counter).
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitResponse('Хэт олон удаа буруу код оруулсан байна. Түр хүлээгээд дахин оролдоно уу.')
});

// Anything that creates a record or costs the server real work: orders, gift
// cards, receipt uploads, QR handshakes.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitResponse('Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.')
});

module.exports = {
  blockKnownScrapers,
  requireBrowserContext,
  noStore,
  globalLimiter,
  publicDataLimiter,
  loginLimiter,
  codeLimiter,
  writeLimiter
};
