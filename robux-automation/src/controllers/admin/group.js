// The group-payout delivery route — settings, the membership clock, and the bot account.
const RobloxGroup = require('../../services/roblox-group');
const { getRequiredDays } = require('../../services/group-eligibility');
const { ACTIONS, recordAdminAction } = require('../../services/audit');

module.exports = {
  async getGroupSettings(req, res) {
    try {
      const groupId = await new Promise((resolve, reject) => {
        this.dbHelpers.getSetting('group_id', (error, row) => (error ? reject(error) : resolve(row?.value || '')));
      });

      let groupName = null;
      if (groupId) {
        try {
          groupName = (await RobloxGroup.getGroupInfo(groupId)).name;
        } catch {
          groupName = null;
        }
      }

      res.json({ success: true, groupId, groupName });
    } catch (error) {
      console.error('Get group settings error:', error);
      res.status(500).json({ success: false, error: 'Группын мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  async updateGroupSettings(req, res) {
    const groupId = String(req.body.groupId || '').trim();
    if (!/^\d+$/.test(groupId)) {
      return res.status(400).json({ success: false, error: 'Группын ID зөвхөн тоо байна.' });
    }

    try {
      const groupInfo = await RobloxGroup.getGroupInfo(groupId);
      if (!groupInfo.name) {
        return res.status(400).json({ success: false, error: 'Ийм ID-тай групп олдсонгүй.' });
      }

      await new Promise((resolve, reject) => {
        this.dbHelpers.setSetting('group_id', groupId, (error) => (error ? reject(error) : resolve()));
      });

      await recordAdminAction(this.dbHelpers, req, ACTIONS.SETTING_UPDATED, {
        entityType: 'setting', details: { setting: 'group_id', groupId, groupName: groupInfo.name }
      });
      res.json({ success: true, message: 'Группын мэдээлэл хадгалагдлаа.', groupId, groupName: groupInfo.name });
    } catch (error) {
      console.error('Update group settings error:', error);
      res.status(502).json({ success: false, error: 'Группын мэдээллийг Roblox-оос шалгаж чадсангүй.' });
    }
  },

  // The membership clock, for support. Roblox never tells us when someone
  // joined, so these dates are ours — and when one is wrong (a buyer who
  // left and rejoined, say) an admin has to be able to reset it by hand.
  async getGroupMemberships(req, res) {
    try {
      const [memberships, requiredDays] = await Promise.all([
        new Promise((resolve, reject) => {
          this.dbHelpers.getAllGroupMemberships((error, rows) => (error ? reject(error) : resolve(rows)));
        }),
        getRequiredDays(this.dbHelpers)
      ]);

      res.json({
        success: true,
        requiredDays,
        memberships: memberships.map((row) => ({
          userId: row.user_id,
          username: row.username,
          robloxId: row.roblox_id,
          groupId: row.group_id,
          joinedAt: row.joined_at,
          source: row.source,
          daysInGroup: Number(row.days_in_group) || 0,
          eligible: (Number(row.days_in_group) || 0) >= requiredDays
        }))
      });
    } catch (error) {
      console.error('Get group memberships error:', error);
      res.status(500).json({ success: false, error: 'Гишүүнчлэлийн мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  // Clears one account's clock. The next membership check re-records it from
  // today, which is the correct handling for someone who left and rejoined.
  async resetGroupMembership(req, res) {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ success: false, error: 'Хэрэглэгчийн ID буруу байна.' });
    }

    try {
      const groupId = await this.getSettingValue('group_id');
      if (!groupId) {
        return res.status(503).json({ success: false, error: 'Групп тохируулагдаагүй байна.' });
      }

      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.deleteGroupMembership(userId, groupId, (error, update) => (
          error ? reject(error) : resolve(update)
        ));
      });
      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Гишүүнчлэлийн бүртгэл олдсонгүй.' });
      }

      // Resetting a clock directly changes when someone becomes eligible for
      // real money, so it's one of the more important entries here.
      await recordAdminAction(this.dbHelpers, req, ACTIONS.GROUP_MEMBERSHIP_RESET, {
        entityType: 'user',
        entityId: userId,
        details: { groupId }
      });

      res.json({ success: true, message: 'Гишүүнчлэлийн хугацаа шинэчлэгдлээ.' });
    } catch (error) {
      console.error('Reset group membership error:', error);
      res.status(500).json({ success: false, error: 'Гишүүнчлэлийг шинэчилж чадсангүй.' });
    }
  },

  // The requirement is 14 days because that's what Roblox enforces. It's
  // configurable only so the number can follow the platform if it ever
  // changes — not as a per-customer discount lever.
  async updateMembershipRequirement(req, res) {
    const days = Number(req.body.requiredDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      return res.status(400).json({
        success: false,
        error: 'Шаардлагатай хоногийг 0-365 хооронд бүхэл тоогоор оруулна уу.'
      });
    }

    try {
      await new Promise((resolve, reject) => {
        this.dbHelpers.setSetting('group_membership_days', String(days), (error) => (
          error ? reject(error) : resolve()
        ));
      });
      await recordAdminAction(this.dbHelpers, req, ACTIONS.SETTING_UPDATED, {
        entityType: 'setting', details: { setting: 'group_membership_days', requiredDays: days }
      });
      res.json({ success: true, message: 'Гишүүнчлэлийн шаардлага шинэчлэгдлээ.', requiredDays: days });
    } catch (error) {
      console.error('Update membership requirement error:', error);
      res.status(500).json({ success: false, error: 'Шаардлагыг шинэчилж чадсангүй.' });
    }
  },

  async getBotStatus(req, res) {
    try {
      const bot = await new Promise((resolve, reject) => {
        this.dbHelpers.getActiveSellerBot((error, row) => (error ? reject(error) : resolve(row)));
      });

      res.json({
        success: true,
        connected: Boolean(bot),
        username: bot?.username || null,
        robloxId: bot?.roblox_id || null
      });
    } catch (error) {
      console.error('Get bot status error:', error);
      res.status(500).json({ success: false, error: 'Bot аккаунтын мэдээлэл авахад алдаа гарлаа.' });
    }
  },

  async updateBotAccount(req, res) {
    const cookie = String(req.body.cookie || '').trim();
    if (!cookie) {
      return res.status(400).json({ success: false, error: 'Bot аккаунтын .ROBLOSECURITY cookie-г оруулна уу.' });
    }

    try {
      const { robloxId, username } = await RobloxGroup.getAuthenticatedBotUser(cookie);

      await new Promise((resolve, reject) => {
        this.dbHelpers.upsertSellerBot(req.session?.adminId, username, robloxId, cookie, (error) => (
          error ? reject(error) : resolve()
        ));
      });

      // Records that the bot account changed and which account it now is —
      // never the cookie itself.
      await recordAdminAction(this.dbHelpers, req, ACTIONS.BOT_ACCOUNT_UPDATED, {
        entityType: 'seller_bot', details: { username, robloxId }
      });
      res.json({ success: true, message: 'Bot аккаунт холбогдлоо.', username, robloxId });
    } catch (error) {
      console.error('Update bot account error:', error.response?.data || error);
      res.status(400).json({
        success: false,
        error: 'Bot аккаунтад холбогдож чадсангүй. Cookie хугацаа дууссан эсвэл буруу байж болзошгүй.'
      });
    }
  },

  async removeBotAccount(req, res) {
    try {
      await new Promise((resolve, reject) => {
        this.dbHelpers.deactivateAllSellerBots((error) => (error ? reject(error) : resolve()));
      });
      await recordAdminAction(this.dbHelpers, req, ACTIONS.BOT_ACCOUNT_REMOVED, { entityType: 'seller_bot' });
      res.json({ success: true, message: 'Bot аккаунтын холболт салгагдлаа.' });
    } catch (error) {
      console.error('Remove bot account error:', error);
      res.status(500).json({ success: false, error: 'Bot аккаунтыг салгаж чадсангүй.' });
    }
  }
};
