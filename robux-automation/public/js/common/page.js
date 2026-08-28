// Page-level behaviours that are not tied to any one feature: the reveal
// animation, the sticky header, the section the nav highlights, the mobile
// nav panel and copy-to-clipboard buttons.

import { reduceMotion } from './format.js';

// Fades sections in as they scroll into view. Any failure here reveals
// everything rather than leaving the page blank — the animation is decoration
// and must never decide whether content is visible.
export function initScrollReveal() {
  const targets = document.querySelectorAll('[data-reveal]');
  if (!targets.length) return;
  const revealAll = () => targets.forEach((el) => el.classList.add('is-visible'));

  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealAll();
    return;
  }

  try {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    targets.forEach((el) => observer.observe(el));
  } catch {
    revealAll();
  }
}

// The header only draws its bottom edge once there is content sliding under
// it. At the top of the page it has nothing to separate itself from, and the
// rule read as a seam across the hero.
export function initStickyHeader() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;

  const sync = () => bar.classList.toggle('is-stuck', window.scrollY > 8);
  sync();
  window.addEventListener('scroll', sync, { passive: true });
}

// Which section of the landing page the nav says you are in.
//
// This is a one-page site whose entire navigation is anchors, and until now
// nothing in the header ever changed as you moved through it: five links that
// looked identical whether you were reading the prices or the FAQ. The
// observer watches the band across the middle of the viewport, so a section
// becomes "current" when it is what you are actually looking at rather than
// the instant its top edge appears.
export function initScrollSpy() {
  const links = [...document.querySelectorAll('.nav-links .nav-link[href^="#"]')];
  if (!links.length || !('IntersectionObserver' in window)) return;

  const byId = new Map();
  links.forEach((link) => {
    const section = document.getElementById(link.getAttribute('href').slice(1));
    if (section) byId.set(section, link);
  });
  if (!byId.size) return;

  const visible = new Set();
  const paint = () => {
    // The topmost visible section wins, so scrolling up through a tall one
    // does not leave the link below it highlighted.
    const current = [...byId.keys()]
      .filter((section) => visible.has(section))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    links.forEach((link) => link.classList.toggle('is-current', byId.get(current) === link));
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    });
    paint();
  }, { rootMargin: '-45% 0px -45% 0px' });

  byId.forEach((_link, section) => observer.observe(section));
}

// Mobile nav. Below the breakpoint the links live in a panel under the bar;
// above it the CSS keeps them inline and this simply never runs.
export function initMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (!toggle || !links) return;

  const setOpen = (open) => {
    links.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Цэс хаах' : 'Цэс нээх');
  };

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  // Following a link should close the panel — it covers the content the
  // link just scrolled to otherwise.
  links.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });

  // A menu that stays open behind the page you tapped through to is a menu
  // you have to dismiss twice.
  document.addEventListener('click', (event) => {
    if (!links.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
}

// Copy-to-clipboard for anything carrying data-copy-target. Shared because
// the storefront uses it for bank details and payment references alike.
export function initCopyButtons() {
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-target]');
    if (!button) return;
    const source = document.getElementById(button.dataset.copyTarget);
    if (!source) return;

    const value = source.textContent.trim();
    if (!value || value === '—') return;

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Insecure context or a denied permission. Selecting the text is the
      // only fallback left, and it still lets the user copy by hand.
      const range = document.createRange();
      range.selectNodeContents(source);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return;
    }

    const original = button.dataset.copyLabel || button.textContent;
    button.dataset.copyLabel = original;
    button.textContent = 'Хуулагдлаа ✓';
    button.classList.add('is-copied');
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      button.textContent = original;
      button.classList.remove('is-copied');
    }, 1600);
  });
}
