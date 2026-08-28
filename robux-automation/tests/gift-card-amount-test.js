// Buying a gift card for a typed amount.
//
// Gift cards used to be sold from the same fixed package list as a normal
// order, so the price came from a package row and the only thing a buyer
// could get wrong was picking the wrong tile. Now they type the amount, which
// makes two things worth pinning down: the bounds, and the fact that the
// price is still computed on this side of the wire.

const assert = require('assert');
const GiftCardController = require('../src/controllers/giftcard-controller');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

// The settings and rows create() reads: the live rate, the buyer's level
// thresholds, and their purchase history — every input to the price except
// the amount itself.
function createStubDb({ pricePer100 = '4500', levels = '[]', purchasedTotal = 0 } = {}) {
  const state = { cards: [] };

  return {
    state,
    getPhoneLinkByUserId(userId, callback) {
      callback(null, { user_id: userId, phone: '99001122' });
    },
    getSetting(key, callback) {
      if (key === 'price_per_100_robux_mnt') return callback(null, { value: pricePer100 });
      if (key === 'level_thresholds') return callback(null, { value: levels });
      callback(null, null);
    },
    getUserPurchasedTotal(userId, callback) { callback(null, purchasedTotal); },
    isPaymentReferenceTaken(reference, callback) { callback(null, false); },
    createGiftCard(code, robuxAmount, priceMnt, paymentReference, purchaserUserId, callback) {
      const card = {
        id: state.cards.length + 1,
        code,
        robux_amount: robuxAmount,
        price_mnt: priceMnt,
        payment_reference: paymentReference,
        purchaser_user_id: purchaserUserId,
        status: 'awaiting_payment'
      };
      state.cards.push(card);
      callback(null, card);
    },
    listActiveBankAccounts(callback) {
      callback(null, [{ id: 1, bank_name: 'Хаан', account_number: '5000', account_holder: 'RBX' }]);
    }
  };
}

const requestFor = (body) => ({ session: { userId: 7 }, body, ip: '127.0.0.1' });

async function create(db, body) {
  const res = createResponse();
  await new GiftCardController(db).create(requestFor(body), res);
  return res;
}

async function testAmountIsPricedFromTheLiveRate() {
  const db = createStubDb({ pricePer100: '4500' });
  const res = await create(db, { robuxAmount: 250 });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.robuxAmount, 250);
  assert.equal(res.body.amountMnt, 11250, '250 R$ at 4,500 ₮ per 100');
  assert.equal(db.state.cards.length, 1);
  assert.equal(db.state.cards[0].price_mnt, 11250, 'the stored price is the quoted one');
  assert.equal(db.state.cards[0].robux_amount, 250);
  console.log('  ✓ a typed amount is priced from the live rate');
}

async function testLevelDiscountStillApplies() {
  // Leaving gift cards out of the loyalty discount would have been a silent
  // change: they were priced through the same engine as an order before.
  const db = createStubDb({
    pricePer100: '4500',
    levels: '[{"threshold":1000,"discountPercent":10}]',
    purchasedTotal: 5000
  });
  const res = await create(db, { robuxAmount: 1000 });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.levelDiscountPercent, 10);
  assert.equal(res.body.amountMnt, 40500, '45,000 ₮ less the buyer’s 10%');
  console.log('  ✓ the buyer’s level discount still applies');
}

async function testPriceSentByTheClientIsIgnored() {
  // The storefront shows a quote it computed itself. If that number could
  // reach the database, a gift card would cost whatever the browser said.
  const db = createStubDb({ pricePer100: '4500' });
  const res = await create(db, { robuxAmount: 500, amountMnt: 1, priceMnt: 1, packageId: 3 });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amountMnt, 22500);
  assert.equal(db.state.cards[0].price_mnt, 22500);
  console.log('  ✓ a price sent by the client buys nothing');
}

async function testAmountsOutsideTheBoundsAreRefused() {
  for (const robuxAmount of [0, -100, 99, 1001, 1000000, 250.5, '250abc', null, undefined]) {
    const db = createStubDb();
    const res = await create(db, { robuxAmount });

    assert.equal(res.statusCode, 400, `${String(robuxAmount)} must be refused`);
    assert.equal(db.state.cards.length, 0, `${String(robuxAmount)} must not create a card`);
  }

  // And the two ends of the range are inside it.
  for (const robuxAmount of [100, 1000]) {
    const db = createStubDb();
    const res = await create(db, { robuxAmount });
    assert.equal(res.statusCode, 200, `${robuxAmount} is a valid amount`);
  }

  console.log('  ✓ amounts outside 100–1,000 R$ are refused, the bounds themselves are not');
}

async function testAnUnlinkedPhoneStillBlocksThePurchase() {
  const db = createStubDb();
  db.getPhoneLinkByUserId = (userId, callback) => callback(null, null);
  const res = await create(db, { robuxAmount: 500 });

  assert.equal(res.statusCode, 403);
  assert.equal(db.state.cards.length, 0);
  console.log('  ✓ a gift card still needs a linked phone number');
}

async function run() {
  await testAmountIsPricedFromTheLiveRate();
  await testLevelDiscountStillApplies();
  await testPriceSentByTheClientIsIgnored();
  await testAmountsOutsideTheBoundsAreRefused();
  await testAnUnlinkedPhoneStillBlocksThePurchase();
  console.log('Gift card amount tests passed');
}

run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
