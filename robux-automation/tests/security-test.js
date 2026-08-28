const assert = require('assert');
const http = require('http');

// These protections are easy to switch off by accident — one middleware moved
// above another, one `app.use` dropped in a merge — and nothing else in the
// suite would notice. Each assertion below is a thing that silently stops
// working if the wiring in src/app.js changes.

const app = require('../src/app');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function request(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, path, method, headers: { 'user-agent': BROWSER_UA, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    // ---- Security headers -------------------------------------------------

    const page = await request(port, '/');
    assert.equal(page.status, 200);

    const csp = page.headers['content-security-policy'];
    assert.ok(csp, 'Content-Security-Policy header is missing');

    // 'unsafe-inline' in script-src would make the nonce pointless: an
    // injected <script> would run without needing to guess anything.
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src must not allow 'unsafe-inline'");
    assert.ok(/frame-ancestors 'none'/.test(csp), 'frame-ancestors must block framing');
    assert.ok(/object-src 'none'/.test(csp), 'object-src must be closed');

    assert.equal(page.headers['x-powered-by'], undefined, 'X-Powered-By should not be advertised');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.ok(page.headers['permissions-policy'], 'Permissions-Policy header is missing');

    // ---- Nonce stamping ---------------------------------------------------

    const nonce = /script-src[^;]*'nonce-([^']+)'/.exec(csp)[1];
    const scriptTags = page.body.match(/<script[^>]*>/g) || [];
    assert.ok(scriptTags.length > 0, 'storefront should contain script tags');
    assert.ok(
      scriptTags.every((tag) => tag.includes(`nonce="${nonce}"`)),
      'every script tag must carry the nonce from this response'
    );

    // Two responses must not share a nonce, or a captured value could be
    // replayed in an injected tag.
    const secondPage = await request(port, '/');
    const secondNonce = /script-src[^;]*'nonce-([^']+)'/.exec(
      secondPage.headers['content-security-policy']
    )[1];
    assert.notEqual(nonce, secondNonce, 'nonce must be regenerated per response');

    // ---- Anti-scraping ----------------------------------------------------

    const fromBrowser = await request(port, '/pricing');
    assert.equal(fromBrowser.status, 200, 'a normal browser must still get pricing');
    assert.equal(
      fromBrowser.headers['cache-control'],
      'no-store, private, max-age=0',
      'priced data must not be cacheable'
    );

    // Self-identifying tooling, refused on the priced endpoints.
    for (const ua of ['curl/8.0.1', 'python-requests/2.31.0', 'Scrapy/2.11', 'Go-http-client/1.1']) {
      const scraped = await request(port, '/pricing', { 'user-agent': ua });
      assert.equal(scraped.status, 403, `${ua} should be refused`);
    }

    // A scripted browser announces itself in the UA and still cannot read the
    // catalogue, however well-formed the rest of the request is.
    const headless = await request(port, '/pricing', {
      'user-agent': 'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin'
    });
    assert.equal(headless.status, 403, 'headless browsers must not read pricing');

    // The same UA on an HTML page has to fail *open*. Antivirus HTTPS
    // scanning and office proxies rewrite the User-Agent of real customers,
    // and a false positive here takes the whole storefront down for them.
    const rewrittenUa = await request(port, '/', {
      'user-agent': 'python-requests/2.31.0',
      'sec-fetch-dest': 'document',
      accept: 'text/html,application/xhtml+xml'
    });
    assert.equal(rewrittenUa.status, 200, 'a browser-shaped page load must survive a rewritten UA');

    // Nothing browser-shaped about it, so the site-wide block still applies.
    const bareTool = await request(port, '/', { 'user-agent': 'curl/8.0.1' });
    assert.equal(bareTool.status, 403, 'a bare tool request should still be refused');

    // Fetch Metadata: a browser cannot set these from page JavaScript, which
    // is what makes them worth checking.
    const crossSite = await request(port, '/pricing', { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403, 'cross-site reads of the catalogue should be refused');

    const sameOrigin = await request(port, '/pricing', { 'sec-fetch-site': 'same-origin' });
    assert.equal(sameOrigin.status, 200, 'same-origin fetches must pass');

    // Absent Fetch Metadata has to fail *open* — an older browser or a proxy
    // that strips headers is a customer, not a scraper.
    const noFetchMetadata = await request(port, '/pricing');
    assert.equal(noFetchMetadata.status, 200, 'missing Sec-Fetch-Site must not block a real client');

    const foreignReferer = await request(port, '/pricing', { origin: 'https://competitor.example' });
    assert.equal(foreignReferer.status, 403, 'a foreign Origin should be refused');

    // A scrubbed User-Agent is forgiven when the request still proves it came
    // from our own page — otherwise the storefront loads and stays empty.
    const strippedUa = await request(port, '/pricing', {
      'user-agent': '',
      'sec-fetch-site': 'same-origin'
    });
    assert.equal(strippedUa.status, 200, 'a same-origin fetch must survive a stripped UA');

    const strippedUaAlone = await request(port, '/pricing', { 'user-agent': '' });
    assert.equal(strippedUaAlone.status, 403, 'a bare request with no UA is still refused');

    // ---- Auth gates -------------------------------------------------------

    const adminData = await request(port, '/admin/orders');
    assert.equal(adminData.status, 401, 'admin routes must require a session');

    const userData = await request(port, '/profile');
    assert.equal(userData.status, 401, 'user routes must require a session');

    // ---- Fallbacks --------------------------------------------------------

    // JSON, not express's default HTML page — which names the framework and
    // echoes the path back.
    const missing = await request(port, '/definitely-not-a-route');
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.body).success, false);

    // ---- robots.txt -------------------------------------------------------

    const robots = await request(port, '/robots.txt');
    assert.equal(robots.status, 200);
    assert.ok(/Disallow: \/admin/.test(robots.body), 'robots.txt must keep crawlers off the dashboard');

    console.log('Security header, nonce, anti-scraping and auth-gate tests passed');
  } finally {
    server.close();
  }
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
