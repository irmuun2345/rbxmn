// Administrator sessions and credentials.
const bcrypt = require('bcrypt');
const { ACTIONS, recordAdminAction } = require('../../services/audit');

module.exports = {
  // Admin login
  async login(req, res) {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ 
          success: false, 
          error: 'Username and password are required' 
        });
      }
      
      const loginResult = await this.adminLogin(username, password);
      
      if (loginResult.success) {
        // Session fixation: an attacker who can plant a known session id in
        // the admin's browser before they log in would otherwise be holding a
        // valid admin cookie the moment they do. Issuing a brand-new id at
        // the privilege change is what breaks that.
        await new Promise((resolve, reject) => {
          req.session.regenerate((error) => (error ? reject(error) : resolve()));
        });

        // Store admin session
        req.session.adminId = loginResult.adminId;
        req.session.adminUsername = loginResult.username;

        // Written before responding, so the cookie the admin receives is
        // already backed by a stored session.
        await new Promise((resolve, reject) => {
          req.session.save((error) => (error ? reject(error) : resolve()));
        });

        await recordAdminAction(this.dbHelpers, req, ACTIONS.ADMIN_LOGIN, {
          entityType: 'admin',
          entityId: loginResult.adminId
        });

        res.json({
          success: true,
          message: 'Admin login successful',
          adminId: loginResult.adminId,
          username: loginResult.username
        });
      } else {
        // Failed attempts are the ones worth having when something goes
        // wrong later, so they're recorded with the attempted username but
        // obviously never the password.
        await recordAdminAction(this.dbHelpers, req, ACTIONS.ADMIN_LOGIN_FAILED, {
          entityType: 'admin',
          details: { attemptedUsername: String(username).slice(0, 64) }
        });

        res.status(401).json({
          success: false,
          error: loginResult.error
        });
      }
    } catch (error) {
      console.error('Admin login error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Admin login failed' 
      });
    }
  },

  // Admin register (for initial setup)
  async register(req, res) {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ 
          success: false, 
          error: 'Username and password are required' 
        });
      }
      
      const adminCount = await new Promise((resolve, reject) => {
        this.dbHelpers.getAdminCount((err, count) => {
          if (err) reject(err);
          else resolve(count);
        });
      });
      
      if (adminCount > 0) {
        return res.status(403).json({
          success: false, 
          error: 'Анхны админ аль хэдийн үүссэн. Шинэ админ бүртгэх хаалттай.'
        });
      }
      
      const registerResult = await this.adminRegister(username, password);
      
      if (registerResult.success) {
        res.json({ 
          success: true, 
          message: 'Admin registered successfully',
          adminId: registerResult.adminId,
          username: registerResult.username
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: registerResult.error 
        });
      }
    } catch (error) {
      console.error('Admin registration error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Admin registration failed' 
      });
    }
  },

  // Admin logout
  async logout(req, res) {
    try {
      // Logged before the session is torn down, so the entry still carries
      // who it was.
      await recordAdminAction(this.dbHelpers, req, ACTIONS.ADMIN_LOGOUT, {
        entityType: 'admin',
        entityId: req.session?.adminId
      });

      // Destroy rather than blank the fields: clearing adminId leaves the
      // session row alive in the store, so a copy of the cookie taken earlier
      // is still a live session that only needs adminId set again. Destroying
      // removes the row, and clearCookie stops the browser re-presenting a
      // dead id on every subsequent request.
      await new Promise((resolve, reject) => {
        req.session.destroy((error) => (error ? reject(error) : resolve()));
      });
      res.clearCookie('rbx.sid');

      res.json({ success: true, message: 'Admin logout successful' });
    } catch (error) {
      console.error('Admin logout error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Admin logout failed' 
      });
    }
  },

  // Get admin profile
  async getProfile(req, res) {
    try {
      const adminId = req.session?.adminId;
      const username = req.session?.adminUsername;
      
      res.json({ 
        success: true, 
        profile: {
          adminId: adminId,
          username: username
        }
      });
    } catch (error) {
      console.error('Get admin profile error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to retrieve admin profile' 
      });
    }
  },

  async changePassword(req, res) {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || typeof newPassword !== 'string' || newPassword.length < 12) {
      return res.status(400).json({
        success: false,
        error: 'Шинэ нууц үг хамгийн багадаа 12 тэмдэгт байна.'
      });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, error: 'Шинэ нууц үг хуучин нууц үгээс өөр байна.' });
    }

    try {
      const verification = await this.adminLogin(req.session?.adminUsername, currentPassword);
      if (!verification.success || verification.adminId !== req.session?.adminId) {
        return res.status(401).json({ success: false, error: 'Одоогийн нууц үг буруу байна.' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      const result = await new Promise((resolve, reject) => {
        this.dbHelpers.updateAdminPassword(req.session?.adminId, passwordHash, (error, update) => {
          if (error) reject(error);
          else resolve(update);
        });
      });

      if (!result.changes) {
        return res.status(404).json({ success: false, error: 'Админ аккаунт олдсонгүй.' });
      }

      await recordAdminAction(this.dbHelpers, req, ACTIONS.ADMIN_PASSWORD_CHANGED, {
        entityType: 'admin', entityId: req.session?.adminId
      });
      res.json({ success: true, message: 'Админы нууц үг шинэчлэгдлээ.' });
    } catch (error) {
      console.error('Change admin password error:', error);
      res.status(500).json({ success: false, error: 'Нууц үг шинэчлэгдсэнгүй.' });
    }
  },

  async getAutomationStatus(req, res) {
    const oauthConfigured = Boolean(
      process.env.ROBLOX_OAUTH_CLIENT_ID && process.env.ROBLOX_OAUTH_CLIENT_SECRET
    );
    const sellerUserId = process.env.ROBLOX_SELLER_USER_ID || null;
    const inventoryVerificationConfigured = Boolean(
      process.env.ROBLOX_OPEN_CLOUD_API_KEY && /^\d+$/.test(sellerUserId || '')
    );

    res.json({
      success: true,
      oauthConfigured,
      inventoryVerificationConfigured,
      sellerUserId
    });
  }
};
