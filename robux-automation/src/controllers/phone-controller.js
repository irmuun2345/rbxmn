// Every order and gift-card action requires the buyer's Roblox account to
// have a phone number locked to it first — one phone number can only ever
// be linked to one Roblox account (enforced at the DB layer, see
// src/models/db.js). This is what stops someone from spreading a single
// leveled-up discount across several Roblox accounts: the level is computed
// per Roblox account, and each person can only ever hold one.
async function ensurePhoneLinked(dbHelpers, userId) {
  const link = await new Promise((resolve, reject) => {
    dbHelpers.getPhoneLinkByUserId(userId, (error, row) => (error ? reject(error) : resolve(row)));
  });
  if (!link) {
    throw Object.assign(
      new Error('Захиалга үүсгэхийн өмнө утасны дугаараа холбоно уу.'),
      { code: 'PHONE_NOT_LINKED' }
    );
  }
  return link;
}

class PhoneController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  async getStatus(req, res) {
    try {
      const link = await new Promise((resolve, reject) => {
        this.dbHelpers.getPhoneLinkByUserId(req.session.userId, (error, row) => (error ? reject(error) : resolve(row)));
      });
      res.json({
        success: true,
        linked: Boolean(link),
        phoneNumber: link ? link.phone_number : null
      });
    } catch (error) {
      console.error('Get phone status error:', error);
      res.status(500).json({ success: false, error: 'Утасны холболтын мэдээлэл авахад алдаа гарлаа.' });
    }
  }

  async link(req, res) {
    const phoneNumber = String(req.body.phoneNumber || '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(phoneNumber)) {
      return res.status(400).json({ success: false, error: 'Утасны дугаараа 8 оронтой тоогоор оруулна уу.' });
    }

    try {
      const existingLink = await new Promise((resolve, reject) => {
        this.dbHelpers.getPhoneLinkByUserId(req.session.userId, (error, row) => (error ? reject(error) : resolve(row)));
      });
      if (existingLink) {
        return res.status(409).json({
          success: false,
          error: 'Таны Roblox аккаунт өөр утасны дугаартай аль хэдийн холбогдсон байна. Админтай холбогдоно уу.'
        });
      }

      await new Promise((resolve, reject) => {
        this.dbHelpers.linkPhoneNumber(phoneNumber, req.session.userId, (error, result) => (
          error ? reject(error) : resolve(result)
        ));
      });

      res.json({ success: true, message: 'Утасны дугаар холбогдлоо.', phoneNumber });
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) {
        return res.status(409).json({
          success: false,
          error: 'Энэ утасны дугаар өөр Roblox аккаунтад аль хэдийн холбогдсон байна.'
        });
      }
      console.error('Link phone error:', error);
      res.status(500).json({ success: false, error: 'Утасны дугаар холбогдсонгүй.' });
    }
  }
}

module.exports = { PhoneController, ensurePhoneLinked };
