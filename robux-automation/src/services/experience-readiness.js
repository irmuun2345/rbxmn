// Whether a buyer's experience can carry a Game Pass that we are able to buy.
//
// A pass is only purchasable from outside its experience when that experience
// is public. That is the only requirement checked; the age rating is read and
// reported for information but does not block an order. The buyer makes the
// experience public on Creator Dashboard and we verify it here, from Roblox,
// every time.
//
// That verification is the gate, not the storefront's checklist. A pass created
// on a private or under-rated experience is a paid order nobody can deliver,
// so createGamePass refuses until this says ready — and refuses when it cannot
// tell (Roblox down, unexpected answer), because guessing "ready" costs money.

const DEFAULT_MIN_AGE = 16;

// Read per call, like the route flag in gamepass-route.js.
function requiredMinimumAge() {
  const configured = Number(process.env.GAMEPASS_MIN_AGE_RATING);
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_MIN_AGE;
}

// Roblox reports the rating as an enum: AGE_RATING_ALL, AGE_RATING_9_PLUS,
// AGE_RATING_13_PLUS, AGE_RATING_17_PLUS, ... Parsed by shape rather than a
// fixed table so a new bracket (16+, 18+) is understood without a code change.
// Null means "not rated" — the questionnaire has not been submitted.
function parseAgeRating(value) {
  const text = String(value || '').toUpperCase();
  if (text === 'AGE_RATING_ALL') return 0;
  const match = text.match(/(\d+)_?PLUS/);
  return match ? Number(match[1]) : null;
}

// universe: the raw Open Cloud Universe resource.
function evaluateReadiness(universe) {
  const requiredAge = requiredMinimumAge();
  const isPublic = String(universe?.visibility || '').toUpperCase() === 'PUBLIC';
  const minimumAge = parseAgeRating(universe?.ageRating);
  const rated = minimumAge !== null;
  const ageOk = rated && minimumAge >= requiredAge;

  return {
    displayName: universe?.displayName || null,
    isPublic,
    rated,
    minimumAge,
    requiredAge,
    ageOk,
    // Only visibility gates an order. The age rating is still read and
    // reported, but is no longer required.
    missing: [!isPublic && 'public'].filter(Boolean),
    ready: isPublic
  };
}

// The buyer-facing sentence for a not-ready experience. Names the steps, never
// the delivery route.
function readinessMessage(readiness) {
  if (readiness.ready) return null;
  return 'Захиалга үүсгэхийн өмнө Creator Dashboard → Manage Audience дээр тоглоомоо Public болгох хэрэгтэй.';
}

module.exports = {
  requiredMinimumAge,
  parseAgeRating,
  evaluateReadiness,
  readinessMessage
};
