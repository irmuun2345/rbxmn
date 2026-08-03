// The numbers a customer sees: Robux pricing and the bank account they pay into.
const { ACTIONS, recordAdminAction } = require('../../services/audit');

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
        error: 'Үнэ 100 MNT-өөс 10,000,000 MNT-ийн хооронд бүхэл тоо байна'
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

  async getBankAccount(req, res) {
    try {
      const [name, accountNumber, accountHolder] = await Promise.all(
        ['bank_name', 'bank_account_number', 'bank_account_holder'].map((key) => new Promise((resolve, reject) => {
          this.dbHelpers.getSetting(key, (error, row) => {
            if (error) reject(error);
            else resolve(row?.value || '');
          });
        }))
      );

      res.json({ success: true, bankName: name, accountNumber, accountHolder });
    } catch (error) {
      console.error('Get bank account error:', error);
      res.status(500).json({ success: false, error: 'Дансны мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  async updateBankAccount(req, res) {
    const bankName = String(req.body.bankName || '').trim();
    const accountNumber = String(req.body.accountNumber || '').trim();
    const accountHolder = String(req.body.accountHolder || '').trim();

    if (!bankName || !accountNumber || !accountHolder) {
      return res.status(400).json({
        success: false,
        error: 'Банк, дансны дугаар, эзэмшигчийн нэрийг бүрэн бөглөнө үү.'
      });
    }
    if (!/^[0-9\- ]{4,32}$/.test(accountNumber)) {
      return res.status(400).json({ success: false, error: 'Дансны дугаарт зөвхөн тоо оруулна.' });
    }

    try {
      await Promise.all([
        ['bank_name', bankName],
        ['bank_account_number', accountNumber],
        ['bank_account_holder', accountHolder]
      ].map(([key, value]) => new Promise((resolve, reject) => {
        this.dbHelpers.setSetting(key, value, (error) => (error ? reject(error) : resolve()));
      })));

      await recordAdminAction(this.dbHelpers, req, ACTIONS.SETTING_UPDATED, {
        entityType: 'setting', details: { setting: 'bank_account', bankName, accountHolder }
      });
      res.json({ success: true, message: 'Дансны мэдээлэл шинэчлэгдлээ.', bankName, accountNumber, accountHolder });
    } catch (error) {
      console.error('Update bank account error:', error);
      res.status(500).json({ success: false, error: 'Дансны мэдээлэл шинэчлэхэд алдаа гарлаа.' });
    }
  }
};
