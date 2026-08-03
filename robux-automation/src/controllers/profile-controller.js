const { computeLevel, parseThresholds } = require('../services/levels');

// The signed-in customer's own view of their account.
//
// This handler used to live inline in the routes file, where its six chained
// database reads were the single largest thing in it. Routes should say what
// is reachable and who may reach it; what a response contains belongs here.
class ProfileController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  // Promisified wrapper for the callback-style repository helpers.
  #query(method, ...args) {
    return new Promise((resolve, reject) => {
      this.dbHelpers[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
    });
  }

  async getProfile(req, res) {
    try {
      const userId = req.session.userId;

      const user = await this.#query('getUserById', userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      const [gamePasses, transactions, totalPurchasedRobux, levelSetting] = await Promise.all([
        this.#query('getGamePassesByUserId', userId),
        this.#query('getTransactionsByUserId', userId),
        // The level is always computed here, from actual purchased orders,
        // never from anything the client sends — that is what keeps it
        // un-fakeable.
        this.#query('getUserPurchasedTotal', userId),
        this.#query('getSetting', 'level_thresholds')
      ]);

      const levelInfo = computeLevel(totalPurchasedRobux, parseThresholds(levelSetting?.value));

      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          robloxId: user.roblox_id,
          createdAt: user.created_at
        },
        gamePasses,
        transactions,
        level: { totalPurchasedRobux, ...levelInfo }
      });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve profile' });
    }
  }
}

module.exports = ProfileController;
