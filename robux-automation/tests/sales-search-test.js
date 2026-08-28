const assert = require('assert');

const AdminController = require('../src/controllers/admin-controller');
const { db, dbHelpers } = require('../src/models/db');

// The HTTP edge of the sales filter.
//
// Everything in a query string arrives as a string an admin half-typed, or as
// whatever someone chose to send. The handler's job is to turn that into
// three well-formed filters or into no filter at all — never into an error,
// because a filter is a question and a malformed one just means the box is
// still being typed into.

const controller = new AdminController(dbHelpers, null, null, null);

async function search(query) {
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    }
  };

  await controller.getSalesSearch({ query }, response);
  return response;
}

async function run() {
  const clean = await search({ from: '2026-01-01', to: '2026-01-31', search: '  batbold  ' });
  assert.strictEqual(clean.statusCode, 200);
  assert.deepStrictEqual(clean.payload.filters, {
    from: '2026-01-01',
    to: '2026-01-31',
    search: 'batbold'
  }, 'a well-formed query survives intact, trimmed');

  // Half-typed dates, a word where a date belongs, and an attempt at SQL all
  // land in the same place: no bound.
  const junk = await search({ from: '2026-1-1', to: "'; DROP TABLE game_passes; --", search: '   ' });
  assert.strictEqual(junk.statusCode, 200);
  assert.deepStrictEqual(junk.payload.filters, { from: null, to: null, search: null });

  // A search long enough to be a paste rather than a name is cut, not refused.
  const long = await search({ search: 'x'.repeat(500) });
  assert.strictEqual(long.payload.filters.search.length, 64);

  // Nothing at all is a valid question: every sale, ever.
  const bare = await search({});
  assert.strictEqual(bare.statusCode, 200);
  assert.deepStrictEqual(bare.payload.filters, { from: null, to: null, search: null });
  assert.ok(Array.isArray(bare.payload.sales));
  assert.ok(Number.isFinite(bare.payload.totals.mnt));
  assert.strictEqual(typeof bare.payload.hasMore, 'boolean');

  // A page size nobody should be able to ask for is clamped rather than
  // honoured — this endpoint must not become a way to pull the whole ledger.
  const huge = await search({ limit: '100000' });
  assert.ok(huge.payload.sales.length <= 200);

  // And a nonsense page size falls back to the default instead of returning
  // nothing at all, which would read as "no sales".
  const nonsense = await search({ limit: 'all', offset: '-5' });
  assert.strictEqual(nonsense.statusCode, 200);

  console.log('Sales search filter validation passed');
  db.close();
}

run().catch((error) => {
  console.error(error);
  db.close();
  process.exitCode = 1;
});
