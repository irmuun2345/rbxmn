// Every action worth reconstructing later goes through here.
//
// Two rules shape this module:
//
//  1. Auditing must never break the thing it is auditing. A failed log write
//     is reported to the console and swallowed — refusing to complete a
//     verified payout because an INSERT failed would be strictly worse than
//     losing one log line.
//
//  2. Nothing sensitive is recorded. Details are whitelisted per call site;
//     receipts, cookies, and tokens are referenced by id, never by content.

const ACTIONS = {
  ADMIN_LOGIN: 'admin.login',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ADMIN_LOGOUT: 'admin.logout',
  ADMIN_PASSWORD_CHANGED: 'admin.password_changed',
  ADMIN_REGISTERED: 'admin.registered',

  ORDER_UNDER_REVIEW: 'order.under_review',
  ORDER_PAYMENT_APPROVED: 'order.payment_approved',
  ORDER_PAYMENT_REJECTED: 'order.payment_rejected',
  ORDER_FULFILLED: 'order.fulfilled',
  ORDER_FULFILLMENT_FAILED: 'order.fulfillment_failed',
  ORDER_FULFILLMENT_DEFERRED: 'order.fulfillment_deferred',
  ORDER_MARKED_FAILED: 'order.marked_failed',

  RECEIPT_SUBMITTED: 'receipt.submitted',
  RECEIPT_DUPLICATE_BLOCKED: 'receipt.duplicate_blocked',
  RECEIPT_VIEWED: 'receipt.viewed',

  GIFT_CARD_APPROVED: 'gift_card.approved',
  GIFT_CARD_REJECTED: 'gift_card.rejected',
  GIFT_CARD_REDEEMED: 'gift_card.redeemed',

  GROUP_JOIN_ACCEPTED: 'group.join_accepted',
  GROUP_MEMBERSHIP_RESET: 'group.membership_reset',

  REFERRAL_CODE_CREATED: 'referral.code_created',
  REFERRAL_CODE_APPLIED: 'referral.code_applied',
  REFERRAL_TERMS_UPDATED: 'referral.terms_updated',
  REFERRAL_PAYOUT_RECORDED: 'referral.payout_recorded',

  SETTING_UPDATED: 'setting.updated',
  BANK_ACCOUNT_CREATED: 'bank_account.created',
  BANK_ACCOUNT_UPDATED: 'bank_account.updated',
  BANK_ACCOUNT_DELETED: 'bank_account.deleted',
  PACKAGE_CREATED: 'package.created',
  PACKAGE_UPDATED: 'package.updated',
  PACKAGE_DELETED: 'package.deleted',
  EVENT_CREATED: 'event.created',
  EVENT_DELETED: 'event.deleted',
  PHONE_UNLINKED: 'phone.unlinked',
  BOT_ACCOUNT_UPDATED: 'bot.account_updated',
  BOT_ACCOUNT_REMOVED: 'bot.account_removed',
  BOT_TWO_FACTOR_UPDATED: 'bot.two_factor_updated',
  BOT_TWO_FACTOR_SOLVED: 'bot.two_factor_solved'
};

// Trusts req.ip, which behind a proxy requires `app.set('trust proxy', ...)`.
// Without it this records the proxy's address — wrong, but never absent.
function clientIp(req) {
  if (!req) return null;
  return req.ip || req.connection?.remoteAddress || null;
}

function write(dbHelpers, entry) {
  return new Promise((resolve) => {
    // Catches the synchronous failures too — a missing helper, a bad handle.
    // Rule 1 is only actually honoured if this function cannot reject for any
    // reason, not just for query errors.
    try {
      dbHelpers.appendAuditLog(entry, (error, result) => {
        if (error) {
          // Loud, but not fatal. See rule 1 above.
          console.error(`Audit log write failed for ${entry.action}:`, error.message);
          return resolve(null);
        }
        resolve(result);
      });
    } catch (error) {
      console.error(`Audit log write threw for ${entry.action}:`, error.message);
      resolve(null);
    }
  });
}

// An action taken by a logged-in administrator.
function recordAdminAction(dbHelpers, req, action, { entityType, entityId, details } = {}) {
  return write(dbHelpers, {
    actorType: 'admin',
    actorId: req?.session?.adminId ?? null,
    actorName: req?.session?.adminUsername ?? null,
    action,
    entityType,
    entityId,
    details,
    ipAddress: clientIp(req)
  });
}

// An action the background poller or a service took with no human involved.
// Distinguishing these is the whole point when reconstructing an incident.
function recordSystemAction(dbHelpers, action, { entityType, entityId, details } = {}) {
  return write(dbHelpers, {
    actorType: 'system',
    actorId: null,
    actorName: 'system',
    action,
    entityType,
    entityId,
    details,
    ipAddress: null
  });
}

// An action initiated by a buyer.
function recordUserAction(dbHelpers, req, action, { entityType, entityId, details } = {}) {
  return write(dbHelpers, {
    actorType: 'user',
    actorId: req?.session?.userId ?? null,
    actorName: req?.session?.username ?? null,
    action,
    entityType,
    entityId,
    details,
    ipAddress: clientIp(req)
  });
}

module.exports = { ACTIONS, recordAdminAction, recordSystemAction, recordUserAction };
