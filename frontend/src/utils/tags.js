/**
 * Unified tag link renderer — the single source of truth for rendering
 * public-facing tag <a> elements across all components.
 *
 * Also owns the singleton flyout used for ancestor-chain display
 * (setupTagFlyout — shared across PostCard, PostContent, PublicFooter).
 */

import { escapeHtml } from './helpers.js';
import { CHEVRON_SVG } from './icons.js';

// ── Hot-zone tracker ─────────────────────────────────────────────────────────
// Shared by the ancestor flyout (post-cards) and the header tag menu.
// Fires onLeave once the cursor moves outside every element in the live set.

/**
 * Track document mousemove and fire onLeave once the cursor exits all elements
 * returned by getEls (with optional padding).
 *
 * @param {function(): (Element|null)[]} getEls  Called on every mousemove; return
 *   the live set of elements that form the hot zone (nulls are skipped).
 * @param {function()}  onLeave  Called when cursor exits the hot zone.
 * @param {number}      [pad=8]  Extra px added to each edge of every element.
 * @returns {{ stop: function() }}  Call stop() to cancel without firing onLeave.
 */
export function createHotZone(getEls, onLeave, pad = 8) {
  const check = (e) => {
    const inside = getEls().some((el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left  - pad &&
        e.clientX <= r.right + pad &&
        e.clientY >= r.top   - pad &&
        e.clientY <= r.bottom + pad
      );
    });
    if (!inside) { stop(); onLeave(); }
  };
  document.addEventListener('mousemove', check, { passive: true });
  function stop() { document.removeEventListener('mousemove', check); }
  return { stop };
}

// ── Flyout singleton ─────────────────────────────────────────────────────────
// One flyout element lives on <body> and is reused by every call site.
// The dismiss listener is also a singleton — replaced on each open — so that
// multiple setupTagFlyout call sites (one per PostCard) don't each add their own
// document-level dismiss that would immediately hide a flyout opened in another card.

let _flyoutEl = null;
let _activeLink = null;
let _activeCard = null;     // card that owns the currently-open flyout
let _hotZone    = null;     // active hot-zone tracker (card + flyout)
let _openTimer  = null;     // pending hover-open timer (singleton — one flyout at a time)
let _flyoutShowTime = 0;    // timestamp of last _showFlyout() call — guards scroll dismiss
let _flyoutDismiss = null;  // singleton dismiss handler, replaced on each open

function _getFlyoutEl() {
  if (!_flyoutEl) {
    _flyoutEl = document.createElement('div');
    _flyoutEl.className = 'post-card-tag-flyout hidden';
    document.body.appendChild(_flyoutEl);
  }
  return _flyoutEl;
}

function _makeChevronIndicator() {
  const NS = 'http://www.w3.org/2000/svg';
  const span = document.createElement('span');
  span.className = 'flyout-indicator';
  span.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M2 3.5L5 6.5L8 3.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

function _showFlyout(anchorEl, ancestors, excludeEl) {
  const flyout = _getFlyoutEl();
  while (flyout.firstChild) flyout.removeChild(flyout.firstChild);
  ancestors.forEach((t) => {
    const a = document.createElement('a');
    a.href = `/tags/${encodeURIComponent(t.slug)}`;
    a.className = 'tag-link';
    a.textContent = t.name;
    flyout.appendChild(a);
  });

  flyout.style.visibility = 'hidden';
  flyout.classList.remove('hidden');
  const flyH = flyout.offsetHeight;
  const flyW = flyout.offsetWidth;

  const anchorRect = anchorEl.getBoundingClientRect();
  const gap = 6;
  let top = anchorRect.top - flyH - gap;
  top = Math.max(8, top);
  // Centre the flyout over the anchor; clamp within the viewport.
  let left = anchorRect.left + anchorRect.width / 2 - flyW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - flyW - 8));

  flyout.style.top = `${top}px`;
  flyout.style.left = `${left}px`;
  flyout.style.visibility = '';
  anchorEl.classList.add('is-flyout-open');
  anchorEl.classList.add('is-active');
  _flyoutShowTime = Date.now();
  _activeCard = anchorEl.closest('.post-card');
  if (_activeCard) _activeCard.classList.add('has-flyout-open');

  // Hot-zone: keep overlay + flyout alive while cursor is over either element.
  _hotZone?.stop();
  const card = _activeCard;
  _hotZone = createHotZone(() => [card, anchorEl, _flyoutEl], () => _hideFlyout());

  // Replace the singleton dismiss listener so it uses the correct excludeEl for
  // whichever card/container just opened the flyout.  A per-setupTagFlyout-instance
  // dismiss would fire for every other card on the page and immediately hide the flyout.
  if (_flyoutDismiss) document.removeEventListener('click', _flyoutDismiss);
  _flyoutDismiss = (e) => {
    if (!_flyoutEl || _flyoutEl.classList.contains('hidden')) return;
    if (_flyoutEl.contains(e.target)) return;
    if (excludeEl && excludeEl.contains(e.target)) return;
    _hideFlyout();
  };
  document.addEventListener('click', _flyoutDismiss);
}

function _hideFlyout() {
  _activeLink?.classList.remove('is-flyout-open');
  _activeLink?.classList.remove('is-active');
  if (_flyoutEl) _flyoutEl.classList.add('hidden');
  _activeLink = null;
  if (_activeCard) {
    _activeCard.classList.remove('has-flyout-open');
    _activeCard = null;
  }
  _hotZone?.stop();
  _hotZone = null;
  if (_flyoutDismiss) {
    document.removeEventListener('click', _flyoutDismiss);
    _flyoutDismiss = null;
  }
}

/** Close the ancestor flyout from outside this module (e.g. immersive hide-UI). */
export function hideFlyout() { _hideFlyout(); }

/**
 * Attach ancestor-flyout behaviour to all .tag-link elements in containerEl.
 *
 * First click on a tag with ancestors → show flyout listing ancestors.
 * Second click on the same tag       → navigate to the tag page.
 * Tags with no ancestors             → navigate normally on first click.
 *
 * @param {HTMLElement} containerEl  Element containing .tag-link anchors.
 * @param {Map|null}    tagIndex     From buildTagIndex(). null = no hierarchy, links navigate directly.
 * @param {Function}    navigateFn  SPA navigate(url) function.
 * @param {HTMLElement} [hostEl]    Clicks inside this element won't dismiss the flyout.
 *                                  Defaults to containerEl.
 * @returns {Function}  Cleanup — call in beforeUnmount.
 */
export function setupTagFlyout(containerEl, tagIndex, navigateFn, hostEl = null) {
  if (!tagIndex) return () => {};

  const excludeEl = hostEl || containerEl;

  containerEl.querySelectorAll('.tag-link').forEach((link) => {
    if (!link.getAttribute('href')) return;
    const slug = link.getAttribute('href').replace('/tags/', '');
    const ancestors = getTagAncestors(slug, tagIndex);
    if (ancestors.length && !link.classList.contains('has-flyout')) {
      link.classList.add('has-flyout');
      link.appendChild(_makeChevronIndicator());
    }

    // Hover open (mouse only — touch uses click below).
    // Same intent-delay pattern as the tags-filters header menu.
    if (ancestors.length) {
      link.addEventListener('mouseenter', () => {
        clearTimeout(_openTimer);
        _openTimer = setTimeout(() => {
          _openTimer = null;
          if (_activeLink === link && _flyoutEl && !_flyoutEl.classList.contains('hidden')) return;
          _hideFlyout();
          _activeLink = link;
          _showFlyout(link, ancestors, excludeEl);
        }, 300);
      });
      link.addEventListener('mouseleave', () => clearTimeout(_openTimer));
    }

    link.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ancestors.length) return; // no ancestors — navigate normally

      clearTimeout(_openTimer);
      e.preventDefault();
      // We don't stop propagation here so that parent components (like PostCard)
      // can also react to the click (e.g. to reveal an image card overlay).

      const flyoutOpenForThisLink =
        _activeLink === link && _flyoutEl && !_flyoutEl.classList.contains('hidden');
      const recentlyOpened = Date.now() - _flyoutShowTime < 300;
      
      if (flyoutOpenForThisLink && !recentlyOpened) {
        _hideFlyout();
        navigateFn(`/tags/${slug}`);
      } else {
        _hideFlyout();
        _activeLink = link;
        _showFlyout(link, ancestors, excludeEl);
      }
    });
  });

  // Dismiss on scroll — still per-instance, but _hideFlyout is idempotent so
  // multiple scroll listeners from different cards are harmless.
  const dismissOnScroll = () => {
    if (Date.now() - _flyoutShowTime < 300) return;
    _hideFlyout();
  };
  window.addEventListener('scroll', dismissOnScroll, { passive: true });

  return () => {
    clearTimeout(_openTimer);
    window.removeEventListener('scroll', dismissOnScroll, { passive: true });
    _hideFlyout();
  };
}

/**
 * Set up scroll arrows for a horizontally-scrollable strip.
 *
 * Adds `.has-scroll-left` / `.has-scroll-right` to trackEl based on
 * scrollEl's scroll position. Wires click handlers to the
 * `.tags-scroll-btn--left` / `.tags-scroll-btn--right` buttons inside trackEl.
 *
 * @param {HTMLElement} trackEl   Wrapper — receives `has-scroll-*` classes
 * @param {HTMLElement} scrollEl  The horizontally-scrollable child
 * @returns {Function} cleanup — call in beforeUnmount
 */
export function setupScrollableStrip(trackEl, scrollEl) {
  if (!trackEl || !scrollEl) return () => {};

  const btnLeft  = trackEl.querySelector('.tags-scroll-btn--left');
  const btnRight = trackEl.querySelector('.tags-scroll-btn--right');

  const update = () => {
    const { scrollLeft, scrollWidth, clientWidth } = scrollEl;
    trackEl.classList.toggle('has-scroll-left',  scrollLeft > 1);
    trackEl.classList.toggle('has-scroll-right', scrollLeft < scrollWidth - clientWidth - 1);
  };

  const onLeft  = () => scrollEl.scrollBy({ left: -200, behavior: 'smooth' });
  const onRight = () => scrollEl.scrollBy({ left:  200, behavior: 'smooth' });

  btnLeft?.addEventListener('click',  onLeft);
  btnRight?.addEventListener('click', onRight);
  scrollEl.addEventListener('scroll', update, { passive: true });

  requestAnimationFrame(update);

  return () => {
    btnLeft?.removeEventListener('click',  onLeft);
    btnRight?.removeEventListener('click', onRight);
    scrollEl.removeEventListener('scroll', update);
  };
}

/**
 * Render a scrollable tag strip with scroll buttons and fades.
 *
 * @param {object[]} postTags  Array of {name, slug} from a post object
 * @param {Map|null} tagIndex  From buildTagIndex() — if present, only shows leaf tags
 * @returns {string} HTML string
 */
export function renderTagStrip(postTags, tagIndex) {
  const visibleTags = (postTags || []).filter((t) => {
    if (!tagIndex) return true;           // navTags not loaded — show all
    const entry = tagIndex.get(t.slug);
    return !entry || entry.isLeaf;        // not in tree → treat as leaf
  });
  const tagsHtml = visibleTags.map((t) => renderTagLink(t)).join('');
  if (!tagsHtml) return '';

  return `
    <div class="tag-strip-track">
      <button class="tags-scroll-btn tags-scroll-btn--left" aria-label="Scroll left" type="button">${CHEVRON_SVG}</button>
      <div class="tag-strip-scroll" aria-label="Tags">${tagsHtml}</div>
      <button class="tags-scroll-btn tags-scroll-btn--right" aria-label="Scroll right" type="button">${CHEVRON_SVG}</button>
    </div>`;
}

/**
 * Set up scrolling, touch suppression, and flyout behavior for a tag strip
 * rendered via renderTagStrip.
 *
 * @param {HTMLElement} container  Element containing the `.tag-strip-track`
 * @param {Map|null}    tagIndex   From buildTagIndex()
 * @param {Function}    navigateFn navigate(url)
 * @param {HTMLElement} [hostEl]   Ancestor for flyout dismissal (usually the card)
 * @returns {Function} cleanup — call in beforeUnmount
 */
export function setupTagStrip(container, tagIndex, navigateFn, hostEl = null) {
  const track = container.querySelector('.tag-strip-track');
  const tagsEl = container.querySelector('.tag-strip-scroll');
  if (!tagsEl) return () => {};

  const cleanups = [];

  // Stop propagation on horizontal touch moves to avoid interference from site gestures
  const stop = (e) => e.stopPropagation();
  tagsEl.addEventListener('touchstart', stop, { passive: true });
  tagsEl.addEventListener('touchmove',  stop, { passive: true });
  cleanups.push(() => {
    tagsEl.removeEventListener('touchstart', stop);
    tagsEl.removeEventListener('touchmove',  stop);
  });

  // Wiring scroll arrows and fades
  cleanups.push(setupScrollableStrip(track, tagsEl));

  // Ancestor flyout (first click/tap)
  cleanups.push(setupTagFlyout(tagsEl, tagIndex, navigateFn, hostEl));

  return () => cleanups.forEach(fn => fn());
}

/**
 * Render a tag link `<a>` element with consistent class structure
 * and optional modifier classes.
 *
 * @param {string|{name:string, slug:string}} tag
 * @param {object}  [opts]
 * @param {boolean} [opts.active=false]  Add `active` class (nav-bar active state).
 * @param {string}  [opts.extra='']      Extra CSS classes appended to `tag-link`.
 * @param {string}  [opts.prefix='']     Raw HTML prepended inside the link before the name (e.g. a lock icon).
 * @param {string}  [opts.suffix='']     Raw HTML appended inside the link after the name
 *                                       (e.g. a `<span class="tag-count">` badge).
 * @returns {string} HTML string
 */
export function renderTagLink(tag, { active = false, extra = '', prefix = '', suffix = '' } = {}) {
  const name = typeof tag === 'string' ? tag : tag.name;
  const slug = typeof tag === 'string' ? tag : tag.slug;
  const href = (typeof tag === 'object' && tag.url) ? tag.url : `/tags/${slug}`;

  const classes = ['tag-link', active ? 'active' : '', extra]
    .filter(Boolean)
    .join(' ');

  return `<a href="${escapeHtml(href)}" class="${classes}">${prefix}${escapeHtml(name)}${suffix}</a>`;
}

/**
 * Build a flat lookup map from the navTags tree.
 * navTags is a strict tree (each node has exactly one parent).
 *
 * @param {object[]} navTags  Root-level tag nodes with nested .children[]
 * @param {string|null} [parentSlug]  Internal — parent slug for recursive calls
 * @param {Map} [map]  Internal — accumulator
 * @returns {Map<string, { tag: {name:string,slug:string}, parentSlug: string|null, isLeaf: boolean }>}
 */
export function buildTagIndex(navTags, parentSlug = null, map = new Map()) {
  for (const tag of navTags) {
    const isLeaf = !tag.children?.length;
    const showInAncestors = tag.show_in_ancestors !== false;
    map.set(tag.slug, { tag: { name: tag.name, slug: tag.slug }, parentSlug, isLeaf, showInAncestors });
    if (!isLeaf) buildTagIndex(tag.children, tag.slug, map);
  }
  return map;
}

/**
 * Return the ancestor chain of a tag in root-first order,
 * skipping system tags (slug starts with '_').
 *
 * @param {string} slug  The leaf tag's slug
 * @param {Map} index    Result of buildTagIndex()
 * @returns {{ name: string, slug: string }[]}  Root-first, immediate parent last
 */
export function getTagAncestors(slug, index) {
  const ancestors = [];
  const visited = new Set([slug]);
  let entry = index.get(slug);
  while (entry?.parentSlug) {
    if (visited.has(entry.parentSlug)) break;  // cycle guard
    visited.add(entry.parentSlug);
    entry = index.get(entry.parentSlug);
    if (entry && !entry.tag.slug.startsWith('_') && entry.showInAncestors !== false) {
      ancestors.unshift(entry.tag);
    }
  }
  return ancestors;
}
