/**
 * Unified tag link renderer — the single source of truth for rendering
 * public-facing tag <a> elements across all components.
 *
 * Also owns the singleton flyout used for ancestor-chain display
 * (setupTagFlyout — shared across PostCard, PostContent, PublicFooter).
 */

import { escapeHtml } from './helpers.js';

// ── Flyout singleton ─────────────────────────────────────────────────────────
// One flyout element lives on <body> and is reused by every call site.

let _flyoutEl = null;
let _activeLink = null;
let _flyoutShowTime = 0; // timestamp of last _showFlyout() call — guards scroll dismiss

function _getFlyoutEl() {
  if (!_flyoutEl) {
    _flyoutEl = document.createElement('div');
    _flyoutEl.className = 'post-card-tag-flyout';
    _flyoutEl.style.display = 'none';
    document.body.appendChild(_flyoutEl);
  }
  return _flyoutEl;
}

function _showFlyout(anchorEl, ancestors) {
  const flyout = _getFlyoutEl();
  while (flyout.firstChild) flyout.removeChild(flyout.firstChild);
  ancestors.forEach((t) => {
    const a = document.createElement('a');
    a.href = `/tag/${encodeURIComponent(t.slug)}`;
    a.className = 'tag-link';
    a.textContent = t.name;
    flyout.appendChild(a);
  });

  flyout.style.visibility = 'hidden';
  flyout.style.display = 'flex';
  const flyH = flyout.offsetHeight;
  const flyW = flyout.offsetWidth;

  const anchorRect = anchorEl.getBoundingClientRect();
  const paddingLeft = parseFloat(getComputedStyle(flyout).paddingLeft) || 0;
  const gap = 6;
  let top = anchorRect.top - flyH - gap;
  top = Math.max(8, top);
  let left = anchorRect.left - paddingLeft;
  left = Math.max(8, Math.min(left, window.innerWidth - flyW - 8));

  flyout.style.top = `${top}px`;
  flyout.style.left = `${left}px`;
  flyout.style.visibility = '';
  _flyoutShowTime = Date.now();
}

function _hideFlyout() {
  if (_flyoutEl) _flyoutEl.style.display = 'none';
  _activeLink = null;
}

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
    link.addEventListener('click', (e) => {
      const slug = link.getAttribute('href').replace('/tag/', '');
      const ancestors = getTagAncestors(slug, tagIndex);
      if (!ancestors.length) return; // no ancestors — navigate normally

      e.preventDefault();
      e.stopPropagation();

      const flyoutOpenForThisLink =
        _activeLink === link && _flyoutEl && _flyoutEl.style.display !== 'none';
      if (flyoutOpenForThisLink) {
        _hideFlyout();
        navigateFn(`/tag/${slug}`);
      } else {
        _hideFlyout();
        _activeLink = link;
        _showFlyout(link, ancestors);
      }
    });
  });

  const dismiss = (e) => {
    if (_flyoutEl && !_flyoutEl.contains(e.target) && !excludeEl.contains(e.target)) {
      _hideFlyout();
    }
  };
  const dismissOnScroll = () => {
    if (Date.now() - _flyoutShowTime < 300) return;
    _hideFlyout();
  };

  document.addEventListener('click', dismiss);
  window.addEventListener('scroll', dismissOnScroll, { passive: true });

  return () => {
    document.removeEventListener('click', dismiss);
    window.removeEventListener('scroll', dismissOnScroll, { passive: true });
    _hideFlyout();
  };
}

/**
 * Render a tag link `<a>` element with consistent class structure
 * and optional modifier classes.
 *
 * @param {string|{name:string, slug:string}} tag
 * @param {object}  [opts]
 * @param {boolean} [opts.active=false]  Add `active` class (nav-bar active state).
 * @param {string}  [opts.extra='']      Extra CSS classes appended to `tag-link`.
 * @param {string}  [opts.suffix='']     Raw HTML appended inside the link after the name
 *                                       (e.g. a `<span class="tag-count">` badge).
 * @returns {string} HTML string
 */
export function renderTagLink(tag, { active = false, extra = '', suffix = '' } = {}) {
  const name = typeof tag === 'string' ? tag : tag.name;
  const slug = typeof tag === 'string' ? tag : tag.slug;

  const classes = ['tag-link', active ? 'active' : '', extra]
    .filter(Boolean)
    .join(' ');

  return `<a href="/tag/${escapeHtml(slug)}" class="${classes}">${escapeHtml(name)}${suffix}</a>`;
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
