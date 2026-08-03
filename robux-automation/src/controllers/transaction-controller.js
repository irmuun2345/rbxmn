class TransactionController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  async getUserTransactions(req, res) {
    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'Эхлээд Roblox аккаунтаа холбоно уу.' });
    }

    try {
      const transactions = await new Promise((resolve, reject) => {
        this.dbHelpers.getTransactionsByUserId(req.session.userId, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });

      res.json({ success: true, transactions });
    } catch (error) {
      console.error('Get user transactions error:', error);
      res.status(500).json({ success: false, error: 'Гүйлгээний мэдээллийг авч чадсангүй.' });
    }
  }
}

module.exports = TransactionController;
