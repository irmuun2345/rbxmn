/**
 * Storefront client-side shield.
 *
 * READ THIS BEFORE RELYING ON IT.
 *
 * None of the code below can *prevent* anyone from opening developer tools or
 * reading this page's source. It cannot be made to. The browser's devtools sit
 * outside the page's reach by design: the menu item, the keyboard shortcut the
 * OS delivers before the page sees it, "view-source:", "Save page as", the
 * Network tab of a second browser, and `curl` all bypass every line here. Any
 * product claiming otherwise is selling a speed bump.
 *
 * What this file honestly is: friction. It turns a casual "let me poke at
 * this" into a deliberate act, which is enough to deter the customer idly
 * pressing F12 — and nothing more.
 *
 * The security that actually holds is on the server, and it already is:
 * - prices, levels and order state are computed server-side from database
 *   rows, never from anything the client sends;
 * - every privileged route sits behind requireAdminAuth / requireAuth;
 * - receipts live outside the web root and stream only through an
 *   admin-gated route.
 *
 * That is why nothing here is load-bearing. Treat a bypass of this file as a
 * cosmetic event, not a breach. If a value would be dangerous for a customer
 * to see or change, it must not reach the browser in the first place.
 */
(function () {
  'use strict';

  var CONFIG = {
    blockContextMenu: true,
    blockShortcuts: true,
    detectDevtools: true,
    // Detection lifts as soon as devtools closes. Making the overlay
    // permanent would mean one false positive bricks the storefront for a
    // paying customer until they clear storage — a far worse outcome than
    // someone reading the markup.
    recoverable: true
  };

  // The admin dashboard is excluded outright: whoever runs it may well need
  // devtools to diagnose a stuck payout, and locking them out of their own
  // tooling helps nobody.
  if (/^\/admin/.test(window.location.pathname)) return;

  // ------------------------------------------------------------------
  // Notice
  // ------------------------------------------------------------------

  // Anyone who reaches the console is told plainly what the risk is. Self-XSS
  // — "paste this to get free Robux" — is the realistic threat to a storefront
  // like this one, and it is social, so the countermeasure is words.
  function printNotice() {
    try {
      var banner = 'background:#17162f;color:#ffd651;font-size:20px;font-weight:700;padding:8px 14px;border-radius:6px';
      console.log('%cЗогсоо!', banner);
      console.log(
        '%cХэн нэгэн энд ямар нэг код хуулж тавихыг хэлсэн бол ЭНЭ БОЛ ЗАЛИЛАН.\n' +
        'Тэр код таны Roblox аккаунт болон rbxmn аккаунтыг хулгайлж болзошгүй.\n' +
        'Хэзээ ч танихгүй хүний өгсөн кодыг энд бүү оруулаарай.',
        'color:#c5c3df;font-size:14px;line-height:1.6'
      );
    } catch (error) {
      // A console that throws is not worth a broken page.
    }
  }

  printNotice();

  // ------------------------------------------------------------------
  // Input friction
  // ------------------------------------------------------------------

  if (CONFIG.blockContextMenu) {
    document.addEventListener('contextmenu', function (event) {
      // Inputs keep their menu — cut/paste/spellcheck are how people fill in
      // a phone number or paste a payment reference, and taking that away is
      // a real usability cost for no security gain.
      if (event.target.closest('input, textarea, [contenteditable]')) return;
      event.preventDefault();
    });
  }

  if (CONFIG.blockShortcuts) {
    document.addEventListener('keydown', function (event) {
      var key = (event.key || '').toLowerCase();
      var mod = event.ctrlKey || event.metaKey;

      // F12, Ctrl/Cmd+Shift+I|J|C, Ctrl/Cmd+U. Note these are *requests* to
      // the browser: Chrome delivers F12 to the page first, so preventDefault
      // works, but the same panel opens from the menu without ever generating
      // a key event.
      var blocked =
        key === 'f12' ||
        (mod && event.shiftKey && (key === 'i' || key === 'j' || key === 'c')) ||
        (mod && key === 'u');

      if (blocked) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
    });
  }

  // ------------------------------------------------------------------
  // Detection
  // ------------------------------------------------------------------

  if (!CONFIG.detectDevtools) return;

  var open = false;
  var overlay = null;

  function buildOverlay() {
    var el = document.createElement('div');
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:#0c0c0d', 'color:#fff', 'text-align:center', 'padding:2rem',
      'font-family:system-ui,sans-serif'
    ].join(';');
    el.innerHTML =
      '<div style="max-width:32rem">' +
      '<div style="font-size:2.5rem;margin-bottom:1rem">🔒</div>' +
      '<h2 style="margin:0 0 .75rem;font-size:1.4rem">Хөгжүүлэгчийн хэрэгсэл илэрлээ</h2>' +
      '<p style="margin:0;color:#c5c3df;line-height:1.7">' +
      'Аюулгүй байдлын үүднээс энэ хэсгийг түр нуулаа. ' +
      'Хөгжүүлэгчийн цонхыг хаавал хуудас автоматаар үргэлжилнэ.' +
      '</p></div>';
    return el;
  }

  function setOpen(next) {
    if (next === open) return;
    open = next;

    if (open) {
      if (!overlay) overlay = buildOverlay();
      if (!overlay.isConnected) document.body.appendChild(overlay);
    } else if (CONFIG.recoverable && overlay && overlay.isConnected) {
      overlay.remove();
    }
  }

  // Detector 1 — console inspection.
  //
  // The getter runs only when devtools actually renders this object in the
  // Console panel. That makes it close to false-positive free, which the
  // viewport heuristic below is not. It's also the reason detection is
  // checked on a timer rather than once: the panel may open at any point.
  var probe = document.createElement('div');
  var inspected = false;
  Object.defineProperty(probe, 'id', {
    get: function () {
      inspected = true;
      return 'shield';
    }
  });

  // Detector 2 — viewport delta.
  //
  // Docked devtools shrink the viewport without changing the window. The
  // threshold is deliberately loose: browser zoom moves innerWidth too, and a
  // customer at 150% zoom must not be told they're hacking. Anything below
  // this is treated as not-devtools even though a small docked panel would
  // slip under it — a missed detection is cheaper than a false one.
  function viewportSuggestsDevtools() {
    if (!window.outerWidth || !window.outerHeight) return false;
    var widthGap = window.outerWidth - window.innerWidth;
    var heightGap = window.outerHeight - window.innerHeight;
    return widthGap > 220 || heightGap > 260;
  }

  function check() {
    inspected = false;
    try {
      console.log(probe);
      // Clearing is the crude half of "make the console unusable": anything
      // typed or logged is wiped on the next tick. It also erases the fraud
      // warning, so that gets reprinted — the console ends up showing the
      // one message worth showing and nothing else, which is the intent.
      console.clear();
      printNotice();
    } catch (error) {
      return;
    }
    setOpen(inspected || viewportSuggestsDevtools());
  }

  // Undocked devtools change neither the viewport nor anything else
  // observable, so this genuinely will not catch a separate window. Accepted:
  // see the note at the top of the file.
  setInterval(check, 1200);
  check();
})();
