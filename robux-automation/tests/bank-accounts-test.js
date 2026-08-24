const assert = require('assert');

const applySchema = require('../src/models/schema');
const createBankAccountRepository = require('../src/models/repositories/bank-accounts');
const { temporaryDatabase, run, all, discard, settle } = require('./helpers/temporary-database');

// Several bank accounts, so a buyer can transfer inside their own bank instead
// of waiting overnight for an interbank clear.
//
// The part worth testing is the migration. Every existing install has its one
// account stored as three rows in `settings`, and an upgrade that dropped it
// would show customers an empty payment panel — an order they cannot pay,
// arriving with no error anywhere.

async function testLegacyAccountIsCarriedOver() {
  const db = temporaryDatabase();

  try {
    // An install as it exists today: one account, held as three settings rows.
    await run(db, 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ)');
    await run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['bank_name', 'Хаан банк']);
    await run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['bank_account_number', '5001234567']);
    await run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['bank_account_holder', 'Г. Бат-Эрдэнэ']);

    applySchema(db);

    await settle(db);

    const accounts = await all(db, 'SELECT * FROM bank_accounts');
    assert.equal(accounts.length, 1, 'the configured account must survive the upgrade');
    assert.equal(accounts[0].bank_name, 'Хаан банк');
    assert.equal(accounts[0].account_number, '5001234567');
    assert.equal(accounts[0].account_holder, 'Г. Бат-Эрдэнэ');
    assert.equal(accounts[0].is_active, true, 'it must still be offered to buyers');

    // Booting again must not import it a second time — the storefront would
    // show the same account twice, growing by one on every restart.
    applySchema(db);
    await settle(db);
    assert.equal((await all(db, 'SELECT * FROM bank_accounts')).length, 1, 'the import must not repeat');

    console.log('  ✓ the single legacy account is carried over exactly once');
  } finally {
    await discard(db);
  }
}

async function testDeletedAccountsStayDeleted() {
  const db = temporaryDatabase();

  try {
    await run(db, 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ)');
    await run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['bank_name', 'Хаан банк']);
    await run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['bank_account_number', '5001234567']);
    await run(db, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['bank_account_holder', 'Г. Бат-Эрдэнэ']);

    applySchema(db);
    await settle(db);

    // The admin closes that account and removes it. The legacy settings rows
    // are still sitting there, so without the flag the next restart would
    // quietly put a closed account back in front of customers.
    await run(db, 'DELETE FROM bank_accounts');

    applySchema(db);
    await settle(db);

    assert.equal(
      (await all(db, 'SELECT * FROM bank_accounts')).length,
      0,
      'a deleted account must not be resurrected from the old settings rows'
    );

    console.log('  ✓ an account the admin deleted is not resurrected on restart');
  } finally {
    await discard(db);
  }
}

async function testOrderingAndActiveFiltering() {
  const db = temporaryDatabase();

  try {
    applySchema(db);
    await settle(db);

    const repository = createBankAccountRepository(db);
    const create = (name, number) => new Promise((resolve, reject) => {
      repository.createBankAccount(name, number, 'Г. Бат-Эрдэнэ', (error, row) => (
        error ? reject(error) : resolve(row)
      ));
    });
    const listActive = () => new Promise((resolve, reject) => {
      repository.listActiveBankAccounts((error, rows) => (error ? reject(error) : resolve(rows)));
    });

    const khan = await create('Хаан банк', '5001234567');
    const golomt = await create('Голомт банк', '1105558888');
    const tdb = await create('Худалдаа хөгжлийн банк', '4990001122');

    // New accounts append. An account jumping to the top of the payment panel
    // because it happened to be added last is not what an admin asked for.
    assert.deepEqual(
      (await listActive()).map((row) => row.bank_name),
      ['Хаан банк', 'Голомт банк', 'Худалдаа хөгжлийн банк']
    );

    await new Promise((resolve, reject) => {
      repository.reorderBankAccounts([tdb.id, khan.id, golomt.id], (error) => (
        error ? reject(error) : resolve()
      ));
    });
    assert.deepEqual(
      (await listActive()).map((row) => row.bank_name),
      ['Худалдаа хөгжлийн банк', 'Хаан банк', 'Голомт банк'],
      'the admin-chosen order is what buyers see'
    );

    // Deactivating is the safe way to retire an account: it stops being
    // offered, but the row survives so an old receipt still resolves to a name.
    await new Promise((resolve, reject) => {
      repository.updateBankAccountRow(khan.id, {
        bankName: 'Хаан банк', accountNumber: '5001234567', accountHolder: 'Г. Бат-Эрдэнэ', isActive: false
      }, (error) => (error ? reject(error) : resolve()));
    });

    const active = await listActive();
    assert.equal(active.length, 2, 'a deactivated account is not offered');
    assert.ok(!active.some((row) => row.id === khan.id));
    assert.equal(
      (await all(db, 'SELECT * FROM bank_accounts WHERE id = ?', [khan.id])).length,
      1,
      'but the row is still there'
    );

    // The same account entered twice is a typo, and one a customer would
    // discover by paying into a duplicate.
    await assert.rejects(
      create('Голомт банк', '1105558888'),
      /duplicate key value violates unique constraint/,
      'the same account must not be addable twice'
    );

    console.log('  ✓ accounts append, reorder, and deactivate without losing history');
  } finally {
    await discard(db);
  }
}

async function main() {
  await testLegacyAccountIsCarriedOver();
  await testDeletedAccountsStayDeleted();
  await testOrderingAndActiveFiltering();
  console.log('Bank account tests passed');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
