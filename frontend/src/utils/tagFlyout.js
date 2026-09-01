import { html, setHTML, raw } from "../utils/helpers.js";
/**
 * The shared tag flyout — one dropdown element, reused by every surface that
 * shows a tag family or a header menu (PostCard, PostContent, PublicFooter,
 * the breadcrumb, the nav "More" panel).
 *
 * It is a singleton on purpose: only one dropdown may be open at a time, and
 * the surfaces that open it do not know about each other. That is also why
 * hideFlyoutWithin exists — see its doc comment.
 *
 * Pure tag helpers (tagHref, renderTagLink, buildTagIndex, …) live in
 * tagLinks.js; the scrollable strip that hosts these triggers on a card is in
 * tagStrip.js.
 */

import { setupLongPress } from './helpers.js';
import { LOCK_SVG } from './icons.js';
import { hasFinePointer, eventPointerType } from './pointerMode.js';
import { tagHref, getTagAncestors } from './tagLinks.js';

/** Hover-intent delay before a header dropdown opens, in ms. */
export const HOVER_OPEN_MS = 180;

// ── Hot-zone tracker ─────────────────────────────────────────────────────────

/**
 * Track document mousemove and fire onLeave once the cursor exits all elements
 * returned by getEls.
 */
export function createHotZone(getEls, onLeave, pad = 8) {
  const check = e => {
    const inside = getEls().some(el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
    });
    if (!inside) {
      stop();
      onLeave();
    }
  };
  document.addEventListener('mousemove', check, {
    passive: true
  });
  function stop() {
    document.removeEventListener('mousemove', check);
  }
  return {
    stop
  };
}

// ── Flyout singleton ─────────────────────────────────────────────────────────

let _flyoutEl = null;
let _activeLink = null;
let _activeCard = null;
let _hotZone = null;
let _openTimer = null;
let _flyoutShowTime = 0;
let _flyoutDismiss = null;
function _getFlyoutEl() {
  if (!_flyoutEl) {
    _flyoutEl = document.createElement('div');
    _flyoutEl.className = 'tag-family-flyout hidden';
    document.body.appendChild(_flyoutEl);
  }
  return _flyoutEl;
}
function _showFlyout(anchorEl, slug, index, excludeEl, navigateFn) {
  const entry = index.get(slug);
  if (!entry) return;
  const ancestors = getTagAncestors(slug, index);
  const ancestorSlugs = ancestors.map(t => t.slug);
  const children = entry.children || [];
  const flyout = _getFlyoutEl();
  while (flyout.firstChild) flyout.removeChild(flyout.firstChild);
  const createItem = (t, className, href) => {
    const a = document.createElement('a');
    a.href = href || `/tags/${t.slug}`;
    a.className = `flyout-item ${className}`;
    setHTML(a, html`<span class="name">${t.name}</span> <span class="count">${t.count}</span>`);
    a.addEventListener('click', e => {
      e.preventDefault();
      _hideFlyout();
      navigateFn(a.pathname + a.search + a.hash);
    });
    return a;
  };

  // 1. Ancestors — each links to itself carrying its truncated path prefix.
  if (ancestors.length) {
    const section = document.createElement('div');
    section.className = 'flyout-section flyout-ancestors';
    ancestors.forEach((t, i) => section.appendChild(createItem(t, 'ancestor-link', tagHref(t.slug, ancestorSlugs.slice(0, i)))));
    flyout.appendChild(section);
  }

  // 2. Current Tag
  const currentSection = document.createElement('div');
  currentSection.className = 'flyout-section flyout-current';
  setHTML(currentSection, html`<span class="name">${entry.tag.name}</span> <span class="count">${entry.tag.count}</span>`);
  flyout.appendChild(currentSection);

  // 3. Children — drilling down appends the current tag to the path chain.
  if (children.length) {
    const childPath = [...ancestorSlugs, slug];
    const section = document.createElement('div');
    section.className = 'flyout-section flyout-children';
    children.forEach(t => section.appendChild(createItem(t, 'child-link', tagHref(t.slug, childPath))));
    flyout.appendChild(section);
  }
  flyout.style.visibility = 'hidden';
  flyout.classList.remove('hidden');
  const isMobile = window.innerWidth < 640;
  if (isMobile) {
    flyout.classList.add('bottom-sheet');
    flyout.style.top = '';
    flyout.style.left = '';
  } else {
    flyout.classList.remove('bottom-sheet');
    const flyH = flyout.offsetHeight;
    const flyW = flyout.offsetWidth;
    const anchorRect = anchorEl.getBoundingClientRect();
    const gap = 8;
    let top = anchorRect.top - flyH - gap;
    if (top < 8) top = anchorRect.bottom + gap;
    let left = anchorRect.left + anchorRect.width / 2 - flyW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - flyW - 8));
    flyout.style.top = `${top}px`;
    flyout.style.left = `${left}px`;
  }
  flyout.style.visibility = '';
  anchorEl.classList.add('is-flyout-open');
  anchorEl.classList.add('is-active');
  _flyoutShowTime = Date.now();
  _activeLink = anchorEl;
  _activeCard = anchorEl.closest('.post-card');
  if (_activeCard) _activeCard.classList.add('has-flyout-open');
  if (!isMobile) {
    _hotZone?.stop();
    _hotZone = createHotZone(() => [_activeCard, anchorEl, _flyoutEl], () => _hideFlyout());
  }
  if (_flyoutDismiss) document.removeEventListener('click', _flyoutDismiss, true);
  _flyoutDismiss = e => {
    if (!_flyoutEl || _flyoutEl.classList.contains('hidden')) return;
    if (_flyoutEl.contains(e.target)) return;
    if (excludeEl && excludeEl.contains(e.target)) return;
    _hideFlyout();
  };
  // Capture phase — a photo card's first tap stops propagation to reveal its
  // overlay, and the flyout must still dismiss when the tap lands there.
  document.addEventListener('click', _flyoutDismiss, true);
}
function _hideFlyout() {
  _activeLink?.classList.remove('is-flyout-open');
  _activeLink?.classList.remove('is-active');
  if (_flyoutEl) {
    _flyoutEl.classList.add('hidden');
    _flyoutEl.classList.remove('bottom-sheet');
    _flyoutEl.style.minWidth = '';
    _flyoutEl.style.maxHeight = '';
    _flyoutEl.style.overflowY = '';
  }
  _activeLink = null;
  if (_activeCard) {
    _activeCard.classList.remove('has-flyout-open');
    _activeCard = null;
  }
  _hotZone?.stop();
  _hotZone = null;
  if (_flyoutDismiss) {
    document.removeEventListener('click', _flyoutDismiss, true);
    _flyoutDismiss = null;
  }
}
export function hideFlyout() {
  _hideFlyout();
}

/** The shared flyout element, or null before anything has ever opened one. */
export function flyoutEl() {
  return _flyoutEl;
}

/**
 * Hide the shared flyout only when its trigger lives inside `root`.
 *
 * The flyout is a singleton, so a surface that closes its own menu (e.g. the
 * nav "More" panel on an outside click) must not blow away a dropdown another
 * surface just opened — on touch both happen in the same click dispatch, which
 * made every breadcrumb/nav tap open a panel and immediately close it again.
 */
export function hideFlyoutWithin(root) {
  if (root && _activeLink && root.contains(_activeLink)) _hideFlyout();
}

/**
 * Anchor the shared flyout singleton directly beneath a trigger element and
 * clamp it inside the viewport. One placement model for every header dropdown
 * (breadcrumb crumbs, nav "More", nav items) — no bottom-sheet, so the panel
 * always appears where the finger tapped instead of sliding up from the
 * screen edge.
 */
function _anchorFlyoutTo(anchorEl) {
  const flyout = _flyoutEl;
  const gap = 8;
  const margin = 8;

  // Cap height to the space below (or above) the trigger so a long list
  // scrolls internally rather than overflowing the viewport.
  flyout.style.maxHeight = '';
  const anchorRect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - anchorRect.bottom - gap - margin;
  const spaceAbove = anchorRect.top - gap - margin;
  const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
  flyout.style.maxHeight = `${Math.max(160, openUp ? spaceAbove : spaceBelow)}px`;
  flyout.style.overflowY = 'auto';
  const flyW = flyout.offsetWidth;
  const flyH = flyout.offsetHeight;
  const top = openUp ? anchorRect.bottom - anchorRect.height - flyH - gap : anchorRect.bottom + gap;

  // Prefer aligning the panel's left edge with the trigger; clamp to viewport.
  let left = anchorRect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - flyW - margin));
  flyout.style.top = `${top}px`;
  flyout.style.left = `${left}px`;
}
function _appendFlyoutLink(section, item, navigateFn, extraClass = '') {
  const a = document.createElement('a');
  a.href = item.href || `/tags/${item.slug}`;
  a.className = `flyout-item ${extraClass}`.trim();
  const lock = item.is_hidden ? raw(LOCK_SVG) : '';
  // No count badge for countless items (custom menu links have no posts).
  const count = item.count ?? item.post_count;
  setHTML(a, html`<span class="name">${lock}${item.name}</span>${count ? html` <span class="count">${count}</span>` : ''}`);
  a.addEventListener('click', e => {
    e.preventDefault();
    _hideFlyout();
    navigateFn(a.pathname + a.search + a.hash);
  });
  section.appendChild(a);
}

/**
 * Show the header dropdown anchored to a trigger element.
 *
 * `spec` is either:
 *   - an Array of {name, slug|href, count} — a flat list (nav "More", nav
 *     items with children); rendered as a single children section, or
 *   - an object { path?, children? } — `path` is the ancestor trail
 *     ({name, href, is_hidden, current}) shown as a top section with the
 *     current crumb highlighted, `children` the drill-down list below it.
 *     This is the breadcrumb case: one panel exposes both "jump up the trail"
 *     and "drill down" so the folded "…" ancestors stay reachable on mobile.
 *
 * @param {HTMLElement} anchorEl   The element to anchor the flyout to
 * @param {object[]|object} spec   Flat item list, or {path, children}
 * @param {Function}    navigateFn navigate(url) function
 * @param {HTMLElement} [excludeEl] Clicks inside this element won't dismiss it
 */
export function showCrumbDropdown(anchorEl, spec, navigateFn, excludeEl = null) {
  _hideFlyout();
  const flyout = _getFlyoutEl();
  while (flyout.firstChild) flyout.removeChild(flyout.firstChild);
  const path = Array.isArray(spec) ? [] : spec?.path || [];
  const children = Array.isArray(spec) ? spec : spec?.children || [];
  if (!path.length && !children.length) return;

  // Path section — ancestor links + highlighted current crumb. Only worth
  // rendering when there's an actual trail (more than the current crumb).
  if (path.length > 1) {
    const section = document.createElement('div');
    section.className = 'flyout-section flyout-path';
    path.forEach(c => {
      if (c.current || !c.href) {
        const span = document.createElement('span');
        span.className = 'flyout-item flyout-path-current';
        const lock = c.is_hidden ? raw(LOCK_SVG) : '';
        setHTML(span, html`<span class="name">${lock}${c.name}</span>`);
        section.appendChild(span);
      } else {
        _appendFlyoutLink(section, c, navigateFn, 'ancestor-link');
      }
    });
    flyout.appendChild(section);
  }
  if (children.length) {
    const section = document.createElement('div');
    section.className = 'flyout-section flyout-children';
    children.forEach(t => _appendFlyoutLink(section, t, navigateFn, 'child-link'));
    flyout.appendChild(section);
  }
  flyout.classList.remove('bottom-sheet');
  flyout.style.minWidth = 'max-content';
  flyout.style.visibility = 'hidden';
  flyout.classList.remove('hidden');
  _anchorFlyoutTo(anchorEl);
  flyout.style.visibility = '';
  anchorEl.classList.add('is-flyout-open');
  _flyoutShowTime = Date.now();
  _activeLink = anchorEl;
  _activeCard = null;
  if (hasFinePointer()) {
    _hotZone?.stop();
    _hotZone = createHotZone(() => [anchorEl, _flyoutEl], () => _hideFlyout());
  }
  if (_flyoutDismiss) document.removeEventListener('click', _flyoutDismiss, true);
  _flyoutDismiss = e => {
    if (!_flyoutEl || _flyoutEl.classList.contains('hidden')) return;
    if (_flyoutEl.contains(e.target)) return;
    if (excludeEl && excludeEl.contains(e.target)) return;
    _hideFlyout();
  };
  document.addEventListener('click', _flyoutDismiss, true);
}

/**
 * Wire a trigger (breadcrumb crumb, nav link, "More" panel row) so its dropdown
 * opens on mouse hover *and* on tap — one interaction model for every header
 * dropdown.
 *
 * Hover is gated on `pointerenter` with `pointerType === 'mouse'` rather than
 * `mouseenter`: a tap emits compatibility mouse events, but pointer events
 * always report the real device, so a finger can never trip the hover path.
 *
 * @param {HTMLElement} el          the trigger
 * @param {Function}    getSpec     () => flyout spec, evaluated at open time
 * @param {Function}    navigateFn  navigate(url)
 * @param {HTMLElement} [excludeEl] clicks inside this element won't dismiss it
 */
export function attachFlyoutTrigger(el, getSpec, navigateFn, excludeEl = null) {
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse') return;
    cancel();
    timer = setTimeout(() => showCrumbDropdown(el, getSpec(), navigateFn, excludeEl), HOVER_OPEN_MS);
  });
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('click', e => {
    cancel();
    // Ask this click what produced it rather than the session-wide verdict: a
    // tap reports pointerType 'touch' even on a machine that has a mouse (and
    // whose remembered verdict is therefore "fine"), and answering from the
    // session there turned every tap on a crumb into a navigation — the arrow
    // flipped on the emulated hover, then the page reloaded out from under the
    // dropdown that was never opened. Keyboard activation reports no pointer
    // type at all; the session verdict is the right answer for it.
    //
    // The click's *own* pointerType can't be asked directly: WebKit tags the
    // compatibility click after a tap as 'mouse', which took every iPad tap
    // down the mouse branch below and left the dropdown unopenable by touch.
    // `eventPointerType` answers from the pointerdown that opened the gesture.
    const pointerType = eventPointerType(e);
    const fromMouse = pointerType ? pointerType === 'mouse' : hasFinePointer();
    // With a mouse the dropdown is already showing from hover, so a click means
    // "go to this item" — let the link navigate.
    if (fromMouse) {
      _hideFlyout();
      return;
    }
    // Coarse pointer: first tap opens the dropdown, second tap follows the link.
    if (el.classList.contains('is-flyout-open')) {
      const href = el.getAttribute('href');
      if (href && href !== '#') {
        _hideFlyout();
        navigateFn(href);
        e.preventDefault();
        return;
      }
    }
    e.preventDefault();
    showCrumbDropdown(el, getSpec(), navigateFn, excludeEl);
  });
}
export function setupTagFlyout(containerEl, tagIndex, navigateFn, hostEl = null) {
  if (!tagIndex) return () => {};
  const excludeEl = hostEl || containerEl;
  const cleanups = [];
  containerEl.querySelectorAll('.tag-link').forEach(link => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http') || !href.startsWith('/tags/')) return;
    const slug = href.replace('/tags/', '').split('?')[0];

    // Desktop hover
    const onEnter = () => {
      clearTimeout(_openTimer);
      _openTimer = setTimeout(() => {
        _openTimer = null;
        if (_activeLink === link && _flyoutEl && !_flyoutEl.classList.contains('hidden')) return;
        _hideFlyout();
        _showFlyout(link, slug, tagIndex, excludeEl, navigateFn);
      }, 250);
    };
    link.addEventListener('mouseenter', onEnter);
    link.addEventListener('mouseleave', () => clearTimeout(_openTimer));
    cleanups.push(() => {
      link.removeEventListener('mouseenter', onEnter);
    });

    // Touch long-press
    cleanups.push(setupLongPress(link, () => {
      _hideFlyout();
      _showFlyout(link, slug, tagIndex, excludeEl, navigateFn);
    }, 350));

    // One click = navigate
    link.addEventListener('click', e => {
      e.stopPropagation();
      clearTimeout(_openTimer);
      _hideFlyout();
    });
  });
  const dismissOnScroll = () => {
    if (Date.now() - _flyoutShowTime < 300) return;
    _hideFlyout();
  };
  window.addEventListener('scroll', dismissOnScroll, {
    passive: true
  });
  return () => {
    cleanups.forEach(fn => fn());
    clearTimeout(_openTimer);
    // No options on removal: listeners match on type + capture, and `passive`
    // is not part of that identity.
    window.removeEventListener('scroll', dismissOnScroll);
    _hideFlyout();
  };
}