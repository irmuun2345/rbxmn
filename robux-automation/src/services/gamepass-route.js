// Whether buyers can be offered the Game Pass delivery route at all.
//
// Roblox disabled cross-game sales of passes and developer products on
// 29 May 2026. Selling a pass from one experience inside another — which is
// precisely what this route does, since the seller buys a buyer's pass without
// ever entering their experience — is no longer a transaction the platform
// permits. The purchase API answers "Invalid arguments", a pass page 404s for
// everyone except the account that created it, and every pass this app has
// created sits at zero sales.
//
// The sanctioned remnant, buying from the Experience Details Page by hand, has
// itself been failing platform-wide with "XSRF token invalid" since 7 August
// 2026 and is unresolved. Roblox's replacement for peer-to-peer Robux, the
// Transfers API, is capped at 500 Robux/day and has to be invoked from inside a
// running experience, so it cannot serve a web storefront.
//
// So the route is closed at the door rather than deleted. Nothing downstream is
// removed: an existing order can still be fulfilled, the seller's inventory can
// still be checked, and the bot can still buy a pass the moment Roblox allows
// it again. Set GAMEPASS_ROUTE_ENABLED=1 to reopen it — that is the only change
// needed if cross-game sales come back.
//
// What closing it buys: buyers stop paying MNT for a delivery that cannot
// happen. Two orders reached "paid, approved, undeliverable" before this
// existed, and every buyer without group eligibility would have joined them.
// Read per call rather than captured at import: a module-level constant makes
// the answer depend on which file was required first, which is a trap for
// tests and for anything that sets configuration during boot.
function isGamePassRouteEnabled() {
  return process.env.GAMEPASS_ROUTE_ENABLED === '1';
}

// Shown to a buyer who would otherwise have been routed here.
// Says nothing about how delivery works, only what the buyer should expect.
const GAMEPASS_DISABLED_MESSAGE =
  'Энэ аккаунтаар одоогоор шууд хүргэх боломжгүй байна. '
  + 'Хэдэн өдрийн дараа автоматаар боломжтой болно — тохиргоо өөрөө бэлдэнэ.';

module.exports = {
  isGamePassRouteEnabled,
  GAMEPASS_DISABLED_MESSAGE
};
