const assert = require('assert');

const applySchema = require('../src/models/schema');
const createOrderRepository = require('../src/models/repositories/orders');
const { ORDER_STATUS } = require('../src/services/order-status');
const { temporaryDatabase, run, discard, settle } = require('./helpers/temporary-database');

// The dashboard's sales totals.
//
// Two things here are easy to get wrong and impossible to notice by looking
// at the number: the day boundary, which is Ulaanbaatar local rather than the
// UTC the rows are stored in, and which orders count at all — a total that
// included unpaid orders would fall every time a payment was rejected.

const get = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
});

// Written straight into the table: createGamePassOrder cannot make a
// completed order, and going through the whole status flow would test the
// flow rather than the arithmetic.
async function addOrder(db, { status, completedAt, robux, mnt, userId = 1, reference = null }) {
  await run(db, `INSERT INTO game_passes
    (user_id, name, price, delivered_robux, amount_mnt, status, completed_at, payment_reference,
     delivery_method)
    VALUES (?, 'Test order', ?, ?, ?, ?, ?, ?, 'group')`,
  [userId, robux, robux, mnt, status, completedAt, reference]);
}

// The same expression the query uses, so the test asks for "18:00 today in
// Ulaanbaatar" rather than guessing at an offset that changes if the country
// ever restores daylight saving.
async function localTimestamp(db, dayOffset) {
  const row = await get(db, `SELECT (
      ((NOW() AT TIME ZONE 'Asia/Ulaanbaatar')::date + ?::int + TIME '18:00')
      AT TIME ZONE 'Asia/Ulaanbaatar'
    ) AS ts`, [dayOffset]);
  return row.ts;
}

async function testPeriodsAndStatuses() {
  const db = temporaryDatabase();

  try {
    applySchema(db);
    await settle(db);
    await run(db, `INSERT INTO users (username, roblox_id) VALUES ('buyer', 1)`);

    const orders = createOrderRepository(db);

    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await localTimestamp(db, 0),
      robux: 1000, mnt: 45000
    });
    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await localTimestamp(db, -1),
      robux: 400, mnt: 18000
    });
    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await localTimestamp(db, -3),
      robux: 100, mnt: 4500
    });
    // Beyond every window except the all-time total.
    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await localTimestamp(db, -400),
      robux: 7, mnt: 315
    });
    // Money that has not been earned yet: paid for, not delivered.
    await addOrder(db, {
      status: ORDER_STATUS.FULFILLMENT_PENDING, completedAt: await localTimestamp(db, 0),
      robux: 5000, mnt: 225000
    });
    // And money that was refused outright.
    await addOrder(db, {
      status: ORDER_STATUS.PAYMENT_REJECTED, completedAt: await localTimestamp(db, 0),
      robux: 9000, mnt: 405000
    });

    const stats = await new Promise((resolve, reject) => {
      orders.getOrderStats((error, row) => (error ? reject(error) : resolve(row)));
    });

    assert.equal(Number(stats.today_orders), 1, 'only the order completed today counts as today');
    assert.equal(Number(stats.today_robux), 1000);
    assert.equal(Number(stats.today_mnt), 45000, 'pending and rejected orders are not revenue');

    assert.equal(Number(stats.yesterday_orders), 1);
    assert.equal(Number(stats.yesterday_robux), 400);

    assert.equal(Number(stats.week_orders), 3, 'the last seven days include today');
    assert.equal(Number(stats.week_robux), 1500);
    assert.equal(Number(stats.week_mnt), 67500);

    assert.equal(Number(stats.total_orders), 4, 'every delivered order is in the total');
    assert.equal(Number(stats.total_robux), 1507);
    assert.equal(Number(stats.total_mnt), 67815);

    console.log('  ✓ only completed orders count, cut by period');
  } finally {
    await discard(db);
  }
}

// The two calendar buckets, on their own database.
//
// They are anchored to the start of the month rather than to a day offset
// because "three days ago" is last month for the first three days of every
// month, and a test that only passes for 28 days out of 31 is worse than no
// test at all.
async function testCalendarMonths() {
  const db = temporaryDatabase();

  try {
    applySchema(db);
    await settle(db);
    await run(db, `INSERT INTO users (username, roblox_id) VALUES ('buyer', 1)`);

    const monthStart = async (dayOffset) => {
      const row = await get(db, `SELECT (
          (date_trunc('month', (NOW() AT TIME ZONE 'Asia/Ulaanbaatar')::date)::date
            + ?::int + TIME '18:00')
          AT TIME ZONE 'Asia/Ulaanbaatar'
        ) AS ts`, [dayOffset]);
      return row.ts;
    };

    // The 1st of this month, and the middle of the one before it.
    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await monthStart(0), robux: 200, mnt: 9000
    });
    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await monthStart(-15), robux: 25, mnt: 1125
    });

    const orders = createOrderRepository(db);
    const stats = await new Promise((resolve, reject) => {
      orders.getOrderStats((error, row) => (error ? reject(error) : resolve(row)));
    });

    assert.equal(Number(stats.month_orders), 1, 'this month holds only the order placed in it');
    assert.equal(Number(stats.month_robux), 200);
    assert.equal(Number(stats.month_mnt), 9000);

    assert.equal(Number(stats.last_month_orders), 1, 'and last month only its own');
    assert.equal(Number(stats.last_month_robux), 25);
    assert.equal(Number(stats.last_month_mnt), 1125);

    console.log('  ✓ this month and last month are calendar months, not day windows');
  } finally {
    await discard(db);
  }
}

// An install on its first day has no orders at all. SUM() over no rows is
// NULL in Postgres, and a NULL reaching the dashboard renders as an empty
// tile rather than a zero.
async function testEmptyDatabaseReportsZeros() {
  const db = temporaryDatabase();

  try {
    applySchema(db);
    await settle(db);

    const orders = createOrderRepository(db);
    const stats = await new Promise((resolve, reject) => {
      orders.getOrderStats((error, row) => (error ? reject(error) : resolve(row)));
    });

    assert.ok(stats, 'a row must come back even with nothing sold');
    assert.equal(Number(stats.today_orders), 0);
    assert.equal(Number(stats.today_robux), 0);
    assert.equal(Number(stats.total_mnt), 0);

    console.log('  ✓ an empty ledger reports zeros, not nulls');
  } finally {
    await discard(db);
  }
}

// The filtered view: a date range, a search box, and a page size.
//
// The two queries behind it must agree — a total that counts rows the list
// below it does not show is worse than no total, because it reads as money
// that has gone missing.
async function testFilteredSales() {
  const db = temporaryDatabase();

  try {
    applySchema(db);
    await settle(db);
    await run(db, `INSERT INTO users (username, roblox_id) VALUES ('Batbold', 111)`);
    await run(db, `INSERT INTO users (username, roblox_id) VALUES ('nomin_e', 222)`);

    const orders = createOrderRepository(db);
    const totals = (filters) => new Promise((resolve, reject) => {
      orders.getSalesTotals(filters, (error, row) => (error ? reject(error) : resolve(row)));
    });
    const rows = (filters, limit = 50, offset = 0) => new Promise((resolve, reject) => {
      orders.searchSales(filters, limit, offset, (error, result) => (
        error ? reject(error) : resolve(result)
      ));
    });

    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await localTimestamp(db, 0),
      robux: 1000, mnt: 45000, userId: 1, reference: 'RBX-AAA1'
    });
    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await localTimestamp(db, -2),
      robux: 400, mnt: 18000, userId: 2, reference: 'RBX-BBB2'
    });
    await addOrder(db, {
      status: ORDER_STATUS.COMPLETED, completedAt: await localTimestamp(db, -30),
      robux: 100, mnt: 4500, userId: 1, reference: 'RBX-CCC3'
    });
    // Never delivered, so it is in none of this however it is filtered.
    await addOrder(db, {
      status: ORDER_STATUS.FULFILLMENT_PENDING, completedAt: await localTimestamp(db, 0),
      robux: 9999, mnt: 450000, userId: 1, reference: 'RBX-DDD4'
    });

    const localDate = async (offset) => (await get(db, `SELECT to_char(
      (NOW() AT TIME ZONE 'Asia/Ulaanbaatar')::date + ?::int, 'YYYY-MM-DD') AS d`, [offset])).d;
    const today = await localDate(0);
    const threeDaysAgo = await localDate(-3);

    const unfiltered = { from: null, to: null, search: null };
    assert.equal(Number((await totals(unfiltered)).orders), 3, 'undelivered orders are never sales');
    assert.equal(Number((await totals(unfiltered)).mnt), 67500);

    const window = { from: threeDaysAgo, to: today, search: null };
    assert.equal(Number((await totals(window)).orders), 2, 'the range excludes the month-old order');
    assert.equal(Number((await totals(window)).robux), 1400);
    assert.equal((await rows(window)).length, 2, 'the list must match the totals above it');

    console.log('  ✓ a date range bounds both the totals and the rows');

    // A username is remembered rather than copied, so case must not matter.
    const byName = { from: null, to: null, search: 'batbold' };
    assert.equal(Number((await totals(byName)).orders), 2, 'search is case-insensitive');
    assert.equal(Number((await totals(byName)).mnt), 49500);

    // A reference is read off a bank statement, often only in part.
    const byReference = { from: null, to: null, search: 'bbb2' };
    const referenceRows = await rows(byReference);
    assert.equal(referenceRows.length, 1);
    assert.equal(referenceRows[0].payment_reference, 'RBX-BBB2');

    // A Roblox id is pasted whole. '11' must not drag in 111.
    assert.equal(Number((await totals({ from: null, to: null, search: '111' })).orders), 2);
    assert.equal(Number((await totals({ from: null, to: null, search: '11' })).orders), 0,
      'a partial Roblox id matches nothing rather than everything');

    // Filters combine rather than replace one another.
    const both = { from: threeDaysAgo, to: today, search: 'nomin' };
    assert.equal(Number((await totals(both)).orders), 1);
    assert.equal(Number((await totals(both)).robux), 400);

    // Paging walks the same ordering without repeating or dropping a row.
    const firstPage = await rows(unfiltered, 2, 0);
    const secondPage = await rows(unfiltered, 2, 2);
    assert.equal(firstPage.length, 2);
    assert.equal(secondPage.length, 1, 'the last page is short, not empty');
    const seen = new Set([...firstPage, ...secondPage].map((row) => Number(row.id)));
    assert.equal(seen.size, 3, 'no order appears on two pages');
    assert.ok(
      new Date(firstPage[0].completed_at) >= new Date(firstPage[1].completed_at),
      'newest first'
    );

    console.log('  ✓ search matches names, references and whole Roblox ids');
    console.log('  ✓ pages walk the results without repeating a row');
  } finally {
    await discard(db);
  }
}

async function run_() {
  await testPeriodsAndStatuses();
  await testCalendarMonths();
  await testFilteredSales();
  await testEmptyDatabaseReportsZeros();
  console.log('Order stats tests passed');
}

run_().catch((error) => {
  console.error(error);
  process.exit(1);
});
