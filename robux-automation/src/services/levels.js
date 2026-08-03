// Reads the level_thresholds setting without ever throwing.
//
// This value is parsed on the checkout path, so a malformed row here would
// take down every order creation and the profile page with a 500 — the whole
// storefront, over a settings field. Levels are a loyalty discount: losing
// them degrades a purchase to full price, which is a far better failure than
// no purchase at all. Anything unparseable is therefore treated as "no levels
// configured" and logged.
function parseThresholds(rawValue) {
  if (!rawValue) return [];

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    console.error('level_thresholds is not valid JSON — treating as no levels:', error.message);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error('level_thresholds is not an array — treating as no levels.');
    return [];
  }

  // A row missing its threshold would sort unpredictably and could hand out
  // the wrong discount, so entries are filtered rather than coerced.
  return parsed.filter((entry) => entry && Number.isFinite(Number(entry.threshold)));
}

// Shared by /profile (display) and the pricing service (discount lookup) so
// the two never drift apart on how a level is derived from lifetime Robux.
function computeLevel(totalRobux, thresholds) {
  const list = Array.isArray(thresholds) ? thresholds : [];
  const sorted = [...list].sort((a, b) => a.threshold - b.threshold);
  let current = null;
  let next = sorted[0] || null;
  for (const entry of sorted) {
    if (totalRobux >= entry.threshold) {
      current = entry;
      next = sorted.find((candidate) => candidate.threshold > entry.threshold) || null;
    }
  }
  return {
    level: current?.level || 0,
    threshold: current?.threshold || 0,
    discountPercent: current?.discountPercent || 0,
    nextLevel: next?.level || null,
    nextThreshold: next?.threshold || null
  };
}

module.exports = { computeLevel, parseThresholds };
