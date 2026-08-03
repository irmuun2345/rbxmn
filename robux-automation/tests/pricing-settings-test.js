const assert = require('assert');
const AdminController = require('../src/controllers/admin-controller');
const { db, dbHelpers } = require('../src/models/db');

const controller = new AdminController(dbHelpers, null, null, null);

async function updatePrice(pricePer100) {
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

  await controller.updatePricing({ body: { pricePer100 } }, response);
  return response;
}

async function getSetting(key) {
  return new Promise((resolve, reject) => {
    dbHelpers.getSetting(key, (error, setting) => error ? reject(error) : resolve(setting));
  });
}

async function run() {
  const invalid = await updatePrice(0);
  assert.strictEqual(invalid.statusCode, 400);

  const valid = await updatePrice(5000);
  assert.strictEqual(valid.statusCode, 200);
  assert.strictEqual(valid.payload.pricePer100, 5000);
  assert.strictEqual(valid.payload.currency, 'MNT');
  assert.strictEqual((await getSetting('price_per_100_robux_mnt')).value, '5000');

  await updatePrice(4500);
  console.log('Pricing validation and persistence check passed');
  db.close();
}

run().catch((error) => {
  console.error(error);
  db.close();
  process.exitCode = 1;
});
