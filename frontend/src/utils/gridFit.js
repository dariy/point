/**
 * Dynamic per-page sizing for the public post grid.
 *
 * The grid is `repeat(auto-fill, minmax(<col>, 1fr))`, so the column count is
 * dictated by the available width. We pick a per_page that fills the first
 * viewport — columns × rows-that-fit — floored at the site's `posts_per_page`
 * setting and capped so a giant display never requests an unbounded page.
 *
 * The most recent result is cached so a fresh page load can size its first
 * fetch synchronously (before the grid exists to be measured); once the grid is
 * on screen, callers re-measure it for an exact column/row count.
 */

import { pluginHost } from '../core/pluginHost.js';

const MAX_PER_PAGE = 60;
// Mobile and tablet viewports (iPad landscape is 1024px) get a fixed page size;
// only wider desktop layouts fan out into enough columns to be worth measuring.
const TABLET_MAX_WIDTH = 1024;
// Pagination + footer sit below the grid; if cards fill the whole viewport they
// get shoved off-screen. Reserve their band so the last row leaves them visible.
// The footer is a plugin slot and can be disabled, so only reserve it when the
// slot is active; the fallback covers the window before it's laid out (its
// fill() is async). ponytail: real heights win once measured.
const FOOTER_FALLBACK = 96;
let _cache = 0;

// Height of the pagination + footer band that must stay visible under the grid.
function belowGridReserve(gridEl) {
  const doc = (gridEl && gridEl.ownerDocument) || document;
  const measure = (sel) => {
    const el = doc.querySelector(sel);
    return el ? el.getBoundingClientRect().height : 0;
  };
  // Pagination is mounted synchronously (only when pages > 1), so its measured
  // height is reliable here. Footer is an async plugin slot — fall back until laid out.
  const footer = pluginHost.hasSlot('footer')
    ? Math.max(FOOTER_FALLBACK, measure('#footer-mount'))
    : 0;
  return measure('#pagination-mount') + footer;
}

/**
 * Resolve a CSS length expression (possibly nested var(), rem, calc, …) to
 * pixels by letting the browser compute it on a throwaway probe element.
 * @param {string} expr  e.g. 'var(--spacing-xl)'
 * @param {HTMLElement} [parent]
 * @returns {number}
 */
function tokenPx(expr, parent = document.body) {
  if (!parent) return 0;
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:${expr};height:${expr}`;
  parent.appendChild(probe);
  const px = probe.offsetWidth;
  probe.remove();
  return px;
}

function columnsForWidth(width, colW, gap) {
  if (!width || !colW) return 1;
  return Math.max(1, Math.floor((width + gap) / (colW + gap)));
}

/**
 * Compute the per_page that fills the viewport for the current layout.
 *
 * @param {number} minPerPage  Floor — the `posts_per_page` setting.
 * @param {HTMLElement|null} [gridEl]  The live `.posts-grid`, when present, for
 *   an exact column/row measurement. When absent, a window-size estimate is
 *   used so a first fetch can be sized before anything is rendered.
 * @returns {number}
 */
export function computePerPage(minPerPage, gridEl = null) {
  const floor = Math.max(1, minPerPage || 1);

  // On mobile and tablets the grid is one or few columns, so filling the
  // viewport buys nothing. Lock the page size to the floor once and skip all
  // measurement — no per-card geometry reads, no re-fit on resize. Only
  // desktop widths recalculate.
  if (window.innerWidth <= TABLET_MAX_WIDTH) {
    _cache = floor;
    return floor;
  }

  let cols;
  let rowH;
  let gap;
  let top;
  let reserve = pluginHost.hasSlot('footer') ? FOOTER_FALLBACK : 0;

  if (gridEl && gridEl.isConnected) {
    const cs = window.getComputedStyle(gridEl);
    cols = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length || 1;
    gap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 0;
    // Row height = the tallest regular (non-featured) slot. The grid stretches
    // every card in a row to the tallest, so a single short text card would
    // under-measure the row and over-request posts (footer off-screen); the
    // featured hero spans a full row and is ~2x taller, so it would do the
    // opposite. Taking the max of the regular slots is stable regardless of how
    // many posts are currently rendered or where the hero sits — no feedback
    // loop. Falls back to the token when only the hero is present.
    const slots = [...gridEl.querySelectorAll('.post-card-slot:not(.featured-post)')];
    rowH =
      slots.reduce((m, s) => Math.max(m, s.getBoundingClientRect().height), 0) ||
      tokenPx('var(--post-cardhas-image-min-height)', gridEl);
    top = gridEl.getBoundingClientRect().top;
    reserve = belowGridReserve(gridEl);
  } else {
    const colW = tokenPx('var(--posts-grid-grid-template-columns)');
    const maxW = tokenPx('var(--content-max-width)');
    const pad = tokenPx('var(--spacing-md)');
    gap = tokenPx('var(--spacing-xl)');
    rowH = tokenPx('var(--post-cardhas-image-min-height)');
    const width = Math.min(window.innerWidth, maxW || window.innerWidth) - 2 * pad;
    cols = columnsForWidth(width, colW, gap);
    // No grid yet — assume it starts a little below the header band. The post-
    // mount re-measure corrects this once the real geometry is known.
    top = Math.min(window.innerHeight * 0.25, 220);
  }

  if (!rowH) {
    _cache = floor;
    return floor;
  }

  const avail = Math.max(rowH, window.innerHeight - top - reserve);
  // Floor (not round): a partial row would spill over the reserved footer band.
  const rows = Math.max(1, Math.floor((avail + gap) / (rowH + gap)));
  // Fit the viewport exactly so pagination + footer stay on-screen. We do NOT
  // floor at posts_per_page here: on narrow desktop widths (few columns) the
  // setting can exceed what fits and would push the footer off-screen. The
  // `floor` is only the fallback when geometry is unmeasurable (above).
  const value = Math.min(MAX_PER_PAGE, cols * rows);
  _cache = value;
  return value;
}

/**
 * Last computed per_page (never below the floor) — for sizing a first fetch
 * synchronously, before the grid is available to measure.
 * @param {number} minPerPage
 * @returns {number}
 */
export function cachedPerPage(minPerPage) {
  const floor = Math.max(1, minPerPage || 1);
  return Math.max(floor, _cache || 0);
}
