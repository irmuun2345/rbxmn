// The Vercel entrypoint.
//
// Every request to the deployment is rewritten here by vercel.json, so this
// one function serves the whole app — the storefront, the API, the admin
// pages and the cron sweep. Express does the routing it always did.
//
// Deliberately thin. It does not start the group-order poller: a serverless
// function is frozen as soon as it responds, so a setInterval set here would
// never fire a second time. That schedule lives in vercel.json and arrives as
// an ordinary HTTP request to /api/cron/group-orders.
//
// `npm start` still runs ../server.js, which does start the poller. The two
// entrypoints share the same app; they differ only in what drives the sweep.

module.exports = require('../src/app');
