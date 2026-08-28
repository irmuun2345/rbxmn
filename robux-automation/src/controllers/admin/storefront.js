// The numbers a customer sees: Robux pricing and the bank accounts they pay into.
const { ACTIONS, recordAdminAction } = require('../../services/audit');
const { isUniqueViolation } = require('../../models/db-errors');

// Column names stay in the data layer; the API speaks camelCase. `sort_order`
// and `created_at` are deliberately not exposed — nothing outside the
// dashboard has any use for them.
function publicBankAccount(row) {
  return {
    id: row.id,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountHolder: row.account_holder
  };
}

// Shared by create and update so the two can never drift apart on what counts
// as a valid account.
function readBankAccountFields(body) {
  const bankName = String(body.bankName || '').trim();
  const accountNumber = String(body.accountNumber || '').trim();
  const accountHolder = String(body.accountHolder || '').trim();

  if (!bankName || !accountNumber || !accountHolder) {
    return { error: 'Банк, дансны дугаар, эзэмшигчийн нэрийг бүрэн бөглөнө үү.' };
  }
  if (bankName.length > 64 || accountHolder.length > 64) {
    return { error: 'Банк болон эзэмшигчийн нэр 64 тэмдэгтээс богино байна.' };
  }
  if (!/^[0-9\- ]{4,32}$/.test(accountNumber)) {
    return { error: 'Дансны дугаарт зөвхөн тоо оруулна.' };
  }

  return { bankName, accountNumber, accountHolder };
}

// The unique index on (bank_name, account_number) catching a re-entered
// account. Worth a 409 rather than a 500: the admin did nothing wrong, they
// just added the same account twice.
function isDuplicateAccount(error) {
  return isUniqueViolation(error);
}

module.exports = {
  async getPricing(req, res) {
    try {
      const setting = await new Promise((resolve, reject) => {
        this.dbHelpers.getSetting('price_per_100_robux_mnt', (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      res.json({
        success: true,
        pricePer100: Number(setting?.value || 4500),
        currency: 'MNT',
        updatedAt: setting?.updated_at || null
      });
    } catch (error) {
      console.error('Get pricing error:', error);
      res.status(500).json({ success: false, error: 'Үнийн мэдээлэл авахад алдаа гарлаа' });
    }
  },

  async updatePricing(req, res) {
    const pricePer100 = Number(req.body.pricePer100);

    if (!Number.isInteger(pricePer100) || pricePer100 < 100 || pricePer100 > 10000000) {
      return res.status(400).json({
        success: false,
        error: 'Үнэ 100 ₮-өөс 10,000,000 ₮-ийн хооронд бүхэл тоо байна'
      });
    }

    try {
      const value = String(pricePer100);
      await new Promise((resolve, reject) => {
        this.dbHelpers.setSetting('price_per_100_robux_mnt', value, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      await recordAdminAction(this.dbHelpers, req, ACTIONS.SETTING_UPDATED, {
        entityType: 'setting',
        details: { setting: 'price_per_100_robux_mnt', pricePer100 }
      });

      res.json({
        success: true,
        message: 'Үнэ шинэчлэгдлээ',
        pricePer100: Number(value),
        currency: 'MNT'
      });
    } catch (error) {
      console.error('Update pricing error:', error);
      res.status(500).json({ success: false, error: 'Үнэ шинэчлэхэд алдаа гарлаа' });
    }
  },

  // Public. The buyer is shown every active account and pays into whichever
  // suits their own bank — an in-bank transfer clears immediately where an
  // interbank one may not. Which account they choose changes nothing on our
  // side: matching is by payment reference, not by destination.
  async listBankAccounts(req, res) {
    try {
      const rows = await new Promise((resolve, reject) => {
        this.dbHelpers.listActiveBankAccounts((error, result) => (error ? reject(error) : resolve(result)));
      });

      res.json({ success: true, accounts: rows.map(publicBankAccount) });
    } catch (error) {
      console.error('List bank accounts error:', error);
      res.status(500).json({ success: false, error: 'Дансны мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  // Admin. Deactivated accounts are included so they can be switched back on.
  async listAllBankAccounts(req, res) {
    try {
      const rows = await new Promise((resolve, reject) => {
        this.dbHelpers.listAllBankAccounts((error, result) => (error ? reject(error) : resolve(result)));
      });

      res.json({
        success: true,
        accounts: rows.map((row) => ({ ...publicBankAccount(row), isActive: Boolean(row.is_active) }))
      });
    } catch (error) {
      console.error('List all bank accounts error:', error);
      res.status(500).json({ success: false, error: 'Дансны мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  async createBankAccount(req, res) {
    const fields = readBankAccountFields(req.body);
    if (fields.error) {
      return res.status(400).json({ success: false, error: fields.error });
    }

    try {
      const created = await new Promise((resolve, reject) => {
        this.dbHelpers.createBankAccount(
          fields.bankName, fields.accountNumber, fields.accountHolder,
          (error, row) => (error ? reject(error) : resolve(row))
        );
      });

      await recordAdminAction(this.dbHelpers, req, ACTIONS.BANK_ACCOUNT_CREATED, {
        entityType: 'bank_account',
        entityId: created.id,
        details: { bankName: fields.bankName, accountHolder: fields.accountHolder }
      });
      res.status(201).json({
        success: true,
        message: 'Данс нэмэгдлээ.',
        account: { id: created.id, ...fields, isActive: true }
      });
    } catch (error) {
      if (isDuplicateAccount(error)) {
        return res.status(409).json({ success: false, error: 'Энэ данс аль хэдийн бүртгэгдсэн байна.' });
      }
      console.error('Create bank account error:', error);
      res.status(500).json({ success: false, error: 'Данс нэмж чадсангүй.' });
    }
  },

  async updateBankAccount(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Дансны ID буруу байна.' });
    }

    const fields = readBankAccountFields(req.body);
    if (fields.error) {
      return res.status(400).json({ success: false, error: fields.error });
    }

    // Defaults to active so an update that omits the flag cannot silently
    // pull an account off the storefront.
    const isActive = req.body.isActive === undefined ? true : Boolean(req.body.isActive);

    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.updateBankAccountRow(
          id, { ...fields, isActive },
          (error, update) => (error ? reject(error) : resolve(update))
        );
      });
      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Данс олдсонгүй.' });
      }

      await recordAdminAction(this.dbHelpers, req, ACTIONS.BANK_ACCOUNT_UPDATED, {
        entityType: 'bank_account',
        entityId: id,
        details: { bankName: fields.bankName, accountHolder: fields.accountHolder, isActive }
      });
      res.json({ success: true, message: 'Данс шинэчлэгдлээ.', account: { id, ...fields, isActive } });
    } catch (error) {
      if (isDuplicateAccount(error)) {
        return res.status(409).json({ success: false, error: 'Энэ данс аль хэдийн бүртгэгдсэн байна.' });
      }
      console.error('Update bank account error:', error);
      res.status(500).json({ success: false, error: 'Данс шинэчилж чадсангүй.' });
    }
  },

  async deleteBankAccount(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Дансны ID буруу байна.' });
    }

    try {
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.deleteBankAccount(id, (error, update) => (error ? reject(error) : resolve(update)));
      });
      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Данс олдсонгүй.' });
      }

      await recordAdminAction(this.dbHelpers, req, ACTIONS.BANK_ACCOUNT_DELETED, {
        entityType: 'bank_account', entityId: id
      });
      res.json({ success: true, message: 'Данс устгагдлаа.' });
    } catch (error) {
      console.error('Delete bank account error:', error);
      res.status(500).json({ success: false, error: 'Данс устгаж чадсангүй.' });
    }
  },

  async reorderBankAccounts(req, res) {
    const ids = Array.isArray(req.body.order) ? req.body.order.map(Number) : null;
    if (!ids || !ids.length || ids.some((id) => !Number.isInteger(id) || id < 1)) {
      return res.status(400).json({ success: false, error: 'Дарааллын жагсаалт буруу байна.' });
    }

    try {
      await new Promise((resolve, reject) => {
        this.dbHelpers.reorderBankAccounts(ids, (error, result) => (error ? reject(error) : resolve(result)));
      });
      res.json({ success: true, message: 'Дараалал хадгалагдлаа.' });
    } catch (error) {
      console.error('Reorder bank accounts error:', error);
      res.status(500).json({ success: false, error: 'Дарааллыг хадгалж чадсангүй.' });
    }
  }
};
