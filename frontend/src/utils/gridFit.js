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

// ── Pinch-zoom ──────────────────────────────────────────────────────────────
// "Zoom" is just a chosen column count (a personal, sticky preference). Rows
// auto-fit the viewport and cards go near-square (CSS), so fewer columns = a few
// big square cards, more columns = many small ones — the post count falls out.
const ZOOM_KEY = 'postGridZoom';
const MIN_CARD_PX = 160; // cards shouldn't shrink narrower than this
const MAX_COLS = 6;      // and never fan out past this many columns

/** The stored zoom (column count), or 0 when unset (auto width-based layout). */
export function getZoom() {
  const v = parseInt(localStorage.getItem(ZOOM_KEY), 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Persist a zoom column count; 0/falsy clears it back to auto. */
export function setZoom(cols) {
  if (cols > 0) localStorage.setItem(ZOOM_KEY, String(cols));
  else localStorage.removeItem(ZOOM_KEY);
}

/** Widest sensible column count for the current viewport (cards ≥ MIN_CARD_PX). */
export function maxZoomCols() {
  const maxW = tokenPx('var(--content-max-width)');
  const pad = tokenPx('var(--spacing-md)');
  const width = Math.min(window.innerWidth, maxW || window.innerWidth) - 2 * pad;
  return Math.max(1, Math.min(MAX_COLS, Math.floor(width / MIN_CARD_PX)));
}

/** Clamp a desired column count to what fits the current viewport. */
export function clampZoom(cols) {
  return Math.max(1, Math.min(cols, maxZoomCols()));
}

/** Live column count of a rendered grid (from its resolved template). */
export function gridCols(gridEl) {
  if (!gridEl) return 0;
  const cs = window.getComputedStyle(gridEl);
  return cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length || 0;
}

/**
 * Reflect the current zoom onto the DOM: a body class + `--posts-grid-cols` var
 * that the CSS reads to pin the column count and square the cards. Clamped to the
 * viewport so a phone never inherits a desktop's 5-column choice. No-op teardown
 * when unset. Idempotent — safe to call on mount, resize, and every step.
 */
export function applyZoomVar() {
  const cols = getZoom();
  if (cols) {
    document.body.classList.add('grid-zoom');
    document.body.style.setProperty('--posts-grid-cols', String(clampZoom(cols)));
  } else {
    document.body.classList.remove('grid-zoom');
    document.body.style.removeProperty('--posts-grid-cols');
  }
}

/**
 * Step the zoom by ±1 column (seeding from the grid's current column count the
 * first time, so the first pinch continues from what's on screen) and apply it.
 * @returns {number} the new clamped column count.
 */
export function stepZoom(gridEl, delta) {
  // Clamp the seed so a stored value wider than the current viewport (or the
  // grid's own column count) doesn't waste the first step on a no-op.
  const current = clampZoom(getZoom() || gridCols(gridEl) || 1);
  const next = clampZoom(current + delta);
  setZoom(next);
  applyZoomVar();
  return next;
}
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
  // The `grid-zoom` body class (set by applyZoomVar) is the single source of
  // truth for "zoom is active on this view". Only pages that opt in (home, tag)
  // add it, so other grids that share computePerPage (e.g. search) ignore zoom.
  const zoomCols =
    document.body.classList.contains('grid-zoom') && getZoom()
      ? clampZoom(getZoom())
      : 0;

  // Landscape mobile/tablet: the grid fans into a few columns and a couple of
  // rows already fill the viewport, so lock to the floor and skip measurement.
  // Portrait phones/tablets fall through: a single column of full-height cards
  // would push the footer far off-screen, so we fit rows to the viewport the
  // same way desktop does (≈3 cards) to keep pagination + footer visible.
  // An explicit zoom overrides this — the user's column choice applies on every
  // viewport, so fit rows to it instead of locking to the floor.
  if (!zoomCols && window.innerWidth <= TABLET_MAX_WIDTH && window.innerWidth >= window.innerHeight) {
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
    const maxW = tokenPx('var(--content-max-width)');
    const pad = tokenPx('var(--spacing-md)');
    gap = tokenPx('var(--spacing-xl)');
    const width = Math.min(window.innerWidth, maxW || window.innerWidth) - 2 * pad;
    if (zoomCols) {
      // Zoom pins the columns; cards are square, so a row is as tall as a card
      // is wide. The post-mount re-measure refines this once laid out.
      cols = zoomCols;
      rowH = (width - (cols - 1) * gap) / cols;
    } else {
      const colW = tokenPx('var(--posts-grid-grid-template-columns)');
      rowH = tokenPx('var(--post-cardhas-image-min-height)');
      cols = columnsForWidth(width, colW, gap);
    }
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
