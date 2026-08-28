const { checkEligibility } = require('../services/group-eligibility');
const { isGamePassRouteEnabled } = require('../services/gamepass-route');

// The buyer-facing side of the membership clock. Its whole reason for
// existing is that the 14-day requirement is unsatisfiable on demand: someone
// who joins the group at checkout still cannot be paid out for two weeks. So
// buyers need a way to join — and start the clock — well before they order,
// and a way to see how much longer they have to wait.
class GroupController {
  constructor(dbHelpers) {
    this.dbHelpers = dbHelpers;
  }

  getSettingValue(key) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getSetting(key, (error, row) => (error ? reject(error) : resolve(row?.value || '')));
    });
  }

  getUser(userId) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getUserById(userId, (error, row) => (error ? reject(error) : resolve(row)));
    });
  }

  // Whether the Gamepass fallback can actually run for this session, and
  // whether the buyer still has a choice to make. One authorized experience
  // means no choice at all — the server picks it — so the client should not
  // render a selector for it.
  describeGamepassAvailability(req) {
    // Closed at the platform's end, not ours — see services/gamepass-route.js.
    // Reported as an explicit state rather than an empty universe list, because
    // "you granted us no experience" and "this route no longer exists" need
    // different things from the buyer.
    if (!isGamePassRouteEnabled()) {
      return {
        available: false,
        needsUniverseChoice: false,
        universeIds: [],
        disabled: true
      };
    }

    const universeIds = (req.session.authorizedUniverseIds || []).map(String);
    return {
      available: universeIds.length > 0,
      needsUniverseChoice: universeIds.length > 1,
      universeIds
    };
  }

  // GET /group/membership — checks Roblox live and returns the countdown.
  // Also the call that starts the clock for someone who joined on their own,
  // since checkEligibility records a membership it hasn't seen before.
  async getMembership(req, res) {
    try {
      const groupId = await this.getSettingValue('group_id');
      if (!groupId) {
        return res.status(503).json({
          success: false,
          error: 'Үйлчилгээ түр хугацаанд боломжгүй байна. Дэмжлэгтэй холбогдоно уу.'
        });
      }

      const user = await this.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'Хэрэглэгч олдсонгүй.' });
      }

      const eligibility = await checkEligibility(this.dbHelpers, user, groupId);

      // The id and the URL used to be echoed here unconditionally, to every
      // signed-in caller, whether or not they had anything to do with them.
      // The countdown is the only part of this a buyer has a use for.
      res.json({
        success: true,
        isMember: eligibility.isMember,
        eligible: eligibility.eligible,
        requiredDays: eligibility.requiredDays,
        daysRemaining: eligibility.daysRemaining
      });
    } catch (error) {
      console.error('Get group membership error:', error);
      res.status(502).json({
        success: false,
        error: 'Аккаунтын төлөв шалгаж чадсангүй. Дахин оролдоно уу.'
      });
    }
  }

  // GET /order/eligibility — which fulfillment route this buyer gets, decided
  // here rather than by the client.
  //
  // Route B (group payout) whenever the membership clock has matured, because
  // it costs us nothing extra and needs no work from the buyer. Route A
  // (Gamepass) otherwise — it works on day one, at the price of Roblox's
  // marketplace cut and the buyer having to own an experience.
  async getFulfillmentRoute(req, res) {
    try {
      const user = await this.getUser(req.session.userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'Хэрэглэгч олдсонгүй.' });
      }

      // The Gamepass route needs an experience the buyer granted us write
      // access to during OAuth. Plenty of buyers own none, and for them the
      // route simply does not exist — the client has to know that up front so
      // it can say why instead of rendering a button that cannot work.
      const gamepass = this.describeGamepassAvailability(req);

      const groupId = await this.getSettingValue('group_id');
      if (!groupId) {
        // No group configured at all, so Gamepass is the only thing we can do.
        return res.json({
          success: true,
          route: 'gamepass',
          reason: 'group_not_configured',
          setup: null,
          gamepass
        });
      }

      const eligibility = await checkEligibility(this.dbHelpers, user, groupId);

      // The whole eligibility record used to be handed to the browser under a
      // `group` key — id, URL, join date, how we learned the join date — on
      // every page load, for every buyer, member or not. All the client can
      // actually do with any of it is open the join page once, and only
      // someone who is not a member yet needs even that. So that is the only
      // case in which a URL is sent, and nothing else about the group ever is.
      res.json({
        success: true,
        route: eligibility.eligible ? 'group' : 'gamepass',
        reason: eligibility.eligible ? 'eligible_for_group' : eligibility.reason,
        setup: eligibility.isMember
          ? null
          : { url: `https://www.roblox.com/groups/${groupId}` },
        gamepass
      });
    } catch (error) {
      console.error('Get fulfillment route error:', error);
      // A Roblox outage shouldn't block ordering — fall back to the route
      // that has no external precondition.
      res.json({
        success: true,
        route: 'gamepass',
        reason: 'eligibility_check_failed',
        setup: null
      });
    }
  }
}

module.exports = GroupController;
