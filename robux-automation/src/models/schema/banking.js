// The bank accounts customers transfer into.
//
// This used to be three rows in `settings` — bank_name, bank_account_number,
// bank_account_holder — which between them described exactly one account.
// Holding several means a buyer can transfer inside their own bank, which is
// the difference between the money arriving now and arriving tomorrow.
//
// Runs after core.js because it reads and writes `settings`.

const { run } = require('./helpers');

const LEGACY_KEYS = ['bank_name', 'bank_account_number', 'bank_account_holder'];

// Set once the single legacy account has been carried across. Without it, an
// admin who deletes every account would find the old one resurrected on the
// next restart — the settings rows are left in place deliberately, so this
// flag is the only thing that says "already done".
const MIGRATED_FLAG = 'bank_accounts_migrated';

function importLegacyAccount(db) {
  db.get('SELECT value FROM settings WHERE key = ?', [MIGRATED_FLAG], (error, flag) => {
    if (error) {
      console.error('Schema: reading bank account migration flag failed:', error.message);
      return;
    }
    if (flag) return;

    db.all(
      'SELECT key, value FROM settings WHERE key IN (?, ?, ?)',
      LEGACY_KEYS,
      (readError, rows) => {
        if (readError) {
          console.error('Schema: reading legacy bank settings failed:', readError.message);
          return;
        }

        const legacy = Object.fromEntries(
          (rows || []).map((row) => [row.key, String(row.value || '').trim()])
        );

        // This callback fires after the enclosing serialize() has returned, so
        // the writes below have to re-serialize themselves — same reason as
        // addMissingColumns in helpers.js.
        db.serialize(() => {
          if (legacy.bank_name && legacy.bank_account_number && legacy.bank_account_holder) {
            run(
              db,
              'bank_accounts legacy import',
              `INSERT INTO bank_accounts
                 (bank_name, account_number, account_holder, sort_order)
               VALUES (?, ?, ?, 0)
               ON CONFLICT (bank_name, account_number) DO NOTHING`,
              [legacy.bank_name, legacy.bank_account_number, legacy.bank_account_holder]
            );
          }

          // Flagged either way. A fresh install has nothing to carry over and
          // should not re-read these three keys on every boot for the rest of
          // its life.
          run(
            db,
            `setting ${MIGRATED_FLAG}`,
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
            [MIGRATED_FLAG, '1']
          );
        });
      }
    );
  });
}

module.exports = function applyBankingSchema(db) {
  run(db, 'bank_accounts table', `CREATE TABLE IF NOT EXISTS bank_accounts (
    id SERIAL PRIMARY KEY,
    bank_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_holder TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);

  // The same account at two different banks is a normal thing to hold; the
  // same number entered twice is a typo, and one an admin would otherwise
  // discover from a customer paying into a duplicate row.
  run(db, 'bank_accounts unique number', `CREATE UNIQUE INDEX IF NOT EXISTS
    idx_bank_accounts_number ON bank_accounts (bank_name, account_number)`);

  importLegacyAccount(db);
};
