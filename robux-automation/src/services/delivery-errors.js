// Turns a failed group delivery into the sentence an admin can act on.
//
// Every failure below used to arrive as one line — "Групп payout илгээж
// чадсангүй. Дахин оролдоно уу." — and that line was worse than uninformative:
// it was wrong in the case that matters most. When Roblox stops answering
// mid-payout the order is deliberately stranded, because the request may have
// landed and re-sending it pays the buyer twice. Telling the admin to try
// again is telling them to do the one thing the strand exists to prevent.
//
// So the message says three things instead: what failed, whether any Robux
// may have moved, and where to go next. `action` carries the same answer in a
// form the UI can branch on.

const ACTION = {
  // A payout that may already have landed. Nobody may retry this — an admin
  // checks the group's payout history and resolves the order by hand.
  RESOLVE: 'resolve',
  // Configuration or credentials. Retrying repeats the same refusal.
  FIX: 'fix',
  // Roblox was unavailable or rate-limited. The poller will come back to it.
  RETRY: 'retry'
};

// Codes whose own message already says what happened; these only add what to
// do about it. Anything not listed falls through to the HTTP mapping below.
const NEXT_STEP = {
  CREDENTIAL_DECRYPT_FAILED: {
    action: ACTION.FIX,
    message: 'Bot-ийн нэвтрэх мэдээллийг задалж чадсангүй — CREDENTIAL_KEY солигдсон байна. '
      + 'Админ → Bot аккаунт хэсэгт cookie болон 2FA секретийг дахин оруулна уу.'
  },
  GROUP_NOT_CONFIGURED: { action: ACTION.FIX, hint: 'Админ → Группын тохиргоо хэсгээс тохируулна уу.' },
  GROUP_PERMISSION_DENIED: { action: ACTION.FIX },
  INSUFFICIENT_GROUP_FUNDS: { action: ACTION.FIX, hint: 'Группд Robux цэнэглээд дахин оролдоно уу.' },
  TOTP_NOT_CONFIGURED: { action: ACTION.FIX },
  TWO_STEP_REJECTED: { action: ACTION.FIX },
  TWO_STEP_FAILED: { action: ACTION.FIX, hint: 'Серверийн цаг болон authenticator секретийг шалгана уу.' },
  UNSUPPORTED_CHALLENGE: {
    action: ACTION.FIX,
    hint: 'Энэ шалгалтыг автоматаар давах боломжгүй — bot аккаунтаар Roblox-д нэвтэрч баталгаажуулна уу.'
  },
  CHALLENGE_METADATA_UNREADABLE: { action: ACTION.FIX },
  CHALLENGE_METADATA_INCOMPLETE: { action: ACTION.FIX },
  INVALID_PAYOUT_AMOUNT: { action: ACTION.FIX, hint: 'Захиалгын дүнг шалгана уу.' },
  PAYOUT_AMOUNT_TOO_LARGE: { action: ACTION.FIX, hint: 'Захиалгын дүнг шалгана уу.' },
  INVALID_RECIPIENT: { action: ACTION.FIX, hint: 'Хэрэглэгчийн Roblox аккаунтын холболтыг шалгана уу.' },
  ORDER_NOT_FOUND: { action: ACTION.FIX },
  WRONG_METHOD: { action: ACTION.FIX },
  WRONG_STATUS: { action: ACTION.FIX }
};

// Roblox puts the useful half of a refusal in the body, not the status line.
function robloxSays(error) {
  return error.response?.data?.errors?.[0]?.message || null;
}

function fromStatus(error) {
  const status = error.response?.status;

  if (status === 401) {
    return {
      action: ACTION.FIX,
      message: 'Roblox bot аккаунтыг таньсангүй — cookie хүчингүй болсон байна. '
        + 'Админ → Bot аккаунт хэсэгт шинэ cookie оруулна уу.'
    };
  }
  if (status === 403) {
    return {
      action: ACTION.FIX,
      message: 'Roblox энэ үйлдлийг зөвшөөрсөнгүй. Bot аккаунтын группын role-д join request '
        + 'хүлээн авах болон группын мөнгө зарцуулах эрх өгсөн эсэхийг шалгана уу.'
    };
  }
  if (status === 429) {
    return {
      action: ACTION.RETRY,
      message: 'Roblox хүсэлтийг түр хязгаарлалаа. Хэдэн минутын дараа автоматаар дахин оролдоно.'
    };
  }
  if (status >= 500) {
    return {
      action: ACTION.RETRY,
      message: `Roblox-ийн сервер алдаа өглөө (${status}). Түр хүлээгээд дахин оролдоно уу.`
    };
  }
  if (!error.response) {
    return {
      action: ACTION.RETRY,
      message: 'Roblox-той холбогдож чадсангүй. Сүлжээгээ шалгаад дахин оролдоно уу.'
    };
  }
  return null;
}

/**
 * @param {Error} error thrown by attemptGroupDelivery
 * @returns {{ message: string, code: string|null, action: string, httpStatus: number }}
 */
function describeDeliveryFailure(error) {
  // Checked before anything else, and deliberately not overridable: whatever
  // else went wrong, an order whose payout may have landed is a resolve, not
  // a retry.
  if (error.payoutMayHaveLanded) {
    return {
      message: 'Roblox тодорхой хариу өгсөнгүй — payout илгээгдсэн эсэх нь тодорхойгүй байна. '
        + 'Захиалгыг түгжлээ. Roblox дээрх группын payout түүхийг шалгаад "Гацсан захиалга" '
        + 'хэсгээс шийдвэрлэнэ үү. Дахин бүү илгээ — хоёр удаа төлөгдөх эрсдэлтэй.',
      code: error.code || null,
      action: ACTION.RESOLVE,
      httpStatus: 409
    };
  }

  if (error.csrfFailure) {
    return {
      message: 'Roblox-той нэвтрэх холболт тогтоож чадсангүй. Bot-ийн cookie хүчингүй болсон '
        + 'байж магадгүй — Админ → Bot аккаунт хэсэгт шинэчилнэ үү. Robux хөдлөөгүй.',
      code: error.code || null,
      action: ACTION.FIX,
      httpStatus: 409
    };
  }

  const known = error.code ? NEXT_STEP[error.code] : null;
  if (known) {
    const body = known.message || error.message;
    return {
      message: known.hint ? `${body} ${known.hint}` : body,
      code: error.code,
      action: known.action,
      httpStatus: known.action === ACTION.RETRY ? 502 : 409
    };
  }

  const byStatus = fromStatus(error);
  if (byStatus) {
    const said = robloxSays(error);
    return {
      message: said ? `${byStatus.message} (Roblox: ${said})` : byStatus.message,
      code: error.code || null,
      action: byStatus.action,
      httpStatus: byStatus.action === ACTION.RETRY ? 502 : 409
    };
  }

  // Nothing recognised it. Roblox's own words beat a house sentence that says
  // less — and if there are none, the error's message is still more than
  // "try again" ever was.
  const detail = robloxSays(error) || error.message || 'тодорхойгүй алдаа';
  return {
    message: `Групп хүргэлт амжилтгүй: ${String(detail).slice(0, 200)}`,
    code: error.code || null,
    action: ACTION.RETRY,
    httpStatus: 502
  };
}

module.exports = { ACTION, describeDeliveryFailure };
