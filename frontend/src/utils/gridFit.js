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
    applyRowsVar(0);
  }
  // Let detached zoom UIs (the footer slider) mirror every change, whatever
  // input path caused it — pinch, wheel, keys, or the slider itself.
  window.dispatchEvent(
    new CustomEvent('point:grid-zoom', { detail: { cols: cols ? clampZoom(cols) : 0 } }),
  );
}

// ── Card image sizing ───────────────────────────────────────────────────────
// A card paints its media as an `<img srcset>` (PostCard), and a srcset is only
// as good as the `sizes` beside it: without one the browser assumes 100vw and
// fetches a full-width rung for every card in a three-across grid.
//
// `sizes` cannot be written as a static media-query list here. The unzoomed
// grid is `repeat(auto-fill, minmax(<col>, 1fr))` — a column count that falls
// out of the available width, the site's own column token and the content
// max-width, none of which a breakpoint list can restate — and the zoomed grid
// pins its columns from localStorage, which no media query can see at all. So
// the value is measured off the laid-out grid instead: PostGrid measures before
// mounting its cards, computePerPage measures again on every fit, and both
// publish through applyCardImageSizes.
//
// The static fallback stands in for the one moment there is nothing to measure:
// markup rendered before the first grid exists (a ghost page built by
// gridPager, a card rendered by a test).

const CARD_SIZES_FALLBACK = '(max-width: 700px) 100vw, 400px';
let _cardSizes = CARD_SIZES_FALLBACK;
let _heroSizes = CARD_SIZES_FALLBACK;

/**
 * The `sizes` attribute a card image should be rendered with.
 *
 * Kept across page changes rather than reset: the next grid is overwhelmingly
 * the same shape as the last one, so the remembered value is a better first
 * paint than the fallback — the same bet cachedPerPage makes.
 *
 * @param {boolean} [isHero]  the featured card, which spans the whole row.
 * @returns {string}
 */
export function cardImageSizes(isHero = false) {
  return isHero ? _heroSizes : _cardSizes;
}

/**
 * Measure a live grid and publish what its cards are painting at.
 *
 * Read off the resolved `grid-template-columns` rather than derived from a
 * column count and a gap: the tracks are the answer the layout already
 * computed, whichever of the two grid definitions produced them.
 *
 * Separate from computePerPage because the two questions have different
 * lifetimes. A page only re-fits per_page when it owns the decision — a URL
 * carrying an explicit `?per_page=` is reproduced as given — but every card
 * that renders needs to know how wide it will paint, on that load too.
 *
 * @param {HTMLElement|null} gridEl  the live `.posts-grid`.
 */
export function measureCardImageSizes(gridEl) {
  if (!gridEl || !gridEl.isConnected) return;
  const rowW = gridEl.getBoundingClientRect().width;
  const tracks = (window.getComputedStyle?.(gridEl)?.gridTemplateColumns || '')
    .split(/\s+/)
    .map(parseFloat)
    .filter((n) => n > 0);
  applyCardImageSizes(tracks.length ? Math.max(...tracks) : rowW, rowW);
}

/**
 * Publish the widths cards are actually painting at.
 *
 * Images already on screen are updated in place: `sizes` is re-evaluated when
 * it changes, so a grid that just went from three columns to one upgrades its
 * cards to the rung they now need. (The browser never downgrades an image it
 * has already fetched, so the reverse costs nothing.)
 *
 * @param {number} cardW  width of one column track, in px.
 * @param {number} rowW   width of the whole grid — the hero spans it.
 * @param {ParentNode} [root]
 */
export function applyCardImageSizes(cardW, rowW, root = document) {
  const px = (v) => (v > 0 ? `${Math.round(v)}px` : CARD_SIZES_FALLBACK);
  const card = px(cardW);
  const hero = px(rowW > 0 ? rowW : cardW);
  if (card === _cardSizes && hero === _heroSizes) return;
  _cardSizes = card;
  _heroSizes = hero;
  for (const img of root.querySelectorAll?.('.post-card-background img') || []) {
    img.sizes = img.closest?.('.featured-post') ? hero : card;
  }
}

// ── Row tracks ──────────────────────────────────────────────────────────────
// The column count alone does not fix a zoomed grid's geometry: rows are
// `minmax(0, 1fr)` and the grid stretches to the viewport, so N cards laid out
// in one row are as tall as the whole page. That is fine once the refit has
// fetched the cards the new column count implies, and wrong for the ~250ms
// before it — the cards balloon, then snap back. Pinning the row *count* the
// fit will land on (`--posts-grid-rows`) gives the grid its final shape in the
// same frame as the step: the cards already there jump straight to their final
// size, and the incoming ones drop into the space held for them.
let _rows = 0;

/** Pin (or, with 0, release) the row tracks a zoomed grid lays out on. */
export function applyRowsVar(rows) {
  _rows = rows > 0 ? rows : 0;
  if (_rows) document.body.style.setProperty('--posts-grid-rows', String(_rows));
  else document.body.style.removeProperty('--posts-grid-rows');
}

/**
 * How many cards the pinned geometry holds (columns × rows), 0 when unzoomed.
 * The grid holds this shape from the zoom step onward, so it is also how many
 * cards belong on screen while the refit is in flight.
 */
export function zoomCapacity() {
  const cols = getZoom() ? clampZoom(getZoom()) : 0;
  return cols && _rows ? cols * _rows : 0;
}

/**
 * Re-measure and re-pin the row tracks for the zoom now in force.
 *
 * The row count wanted here is exactly the one the refit will apply, so this is
 * computePerPage itself, called for its `--posts-grid-rows` side effect. The
 * floor argument is irrelevant to that side effect (it only stands in when the
 * geometry is unmeasurable), hence 1.
 */
export function pinZoomRows(gridEl) {
  if (gridEl) computePerPage(1, gridEl);
}

/** Set an absolute zoom column count (from the footer slider) and apply it. */
export function requestZoom(cols, gridEl = null) {
  setZoom(clampZoom(cols));
  applyZoomVar();
  pinZoomRows(gridEl);
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
  pinZoomRows(gridEl);
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
  // Distraction-free mode is the one layout where the footer is not below the
  // grid at all: it is parked off-screen and flicked up *over* it as the mode's
  // overlay (plugins/distraction-free), so it reserves nothing. The paginator
  // measures 0 there on its own — that mode hides it outright.
  const footerOverGrid = doc.body?.classList.contains('distraction-free');
  const footer = pluginHost.hasSlot('footer') && !footerOverGrid
    ? Math.max(FOOTER_FALLBACK, measure('#footer-mount'))
    : 0;
  // .site-main's bottom padding sits under the pagination and above the footer,
  // and it is real height the grid does not get. Omitting it made `avail` 24px
  // (--spacing-lg) too generous — enough, on a 390px-wide phone, to tip a 1.96-
  // row fit up to 2 and leave the page permanently 11px longer than the
  // viewport. Read off the live element rather than the token so a theme that
  // repads .site-main is measured, not assumed.
  const main = doc.querySelector('.site-main');
  const mainPadBottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
  return measure('#pagination-mount') + footer + mainPadBottom;
}

// The chrome bracketing the grid — everything computePerPage has to measure
// around it, above (`top`) and below (`belowGridReserve`).
const CHROME_MOUNTS = ['#header-mount', '#timeline-mount', '#pagination-mount', '#footer-mount'];

/**
 * Re-run a viewport fit whenever the chrome bracketing the grid changes height.
 *
 * The header, timeline and footer are async plugin slots that render, then
 * fetch, then render again, so the fit a page schedules on a rAF after its own
 * grid measures a layout that is not finished: an empty timeline leaves the grid
 * 64px too high and an unmounted footer falls back to FOOTER_FALLBACK, between
 * them offering a phone ~590px of room where the settled page has ~460. That is
 * one row too many, and the page stays past the viewport for good — the fit is
 * never asked again. Awaiting the slots' mount() promises does not fix it
 * (several render their real content a tick later still); watching the boxes is
 * indifferent to how late any of them arrives, and keeps working afterwards when
 * the same chrome changes size (a footer that wraps, a timeline toggled off).
 *
 * @param {ParentNode} root  the page element holding the mounts.
 * @param {() => void} onSettle  re-fit callback; must be idempotent, since a
 *   settled layout can still emit a final no-op observation.
 * @returns {() => void} teardown — disconnects the observer and cancels a
 *   pending callback. Safe to call more than once.
 */
export function watchChromeFit(root, onSettle) {
  if (!root || typeof ResizeObserver === 'undefined') return () => {};
  let timer;
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    // Debounced: a slot that renders in two passes would otherwise re-fit twice,
    // and the second fit is the only one measuring anything real.
    timer = setTimeout(onSettle, 120);
  });
  for (const sel of CHROME_MOUNTS) {
    const el = root.querySelector(sel);
    if (el) ro.observe(el);
  }
  return () => {
    clearTimeout(timer);
    ro.disconnect();
  };
}

/**
 * Guard for a fit that never settles.
 *
 * computePerPage measures the chrome around the grid, and the pagination band
 * is part of that chrome while also being a *function* of per_page: 25 posts at
 * 4 a page is 7 pages, which Pagination lays out in full and wraps onto two
 * lines on a phone; at 2 a page it is 13 pages, past the threshold where the
 * paginator switches to its compact ellipsis form and fits on one line. So a
 * 375×667 viewport with two zoom columns fits two rows while the paginator is
 * compact (per_page 4) and one row once it is not (per_page 2), each value
 * implying the other for as long as the page is open — the visible flicker.
 *
 * Any chrome whose height depends on the post count can close that loop, so the
 * fit guards itself rather than the paginator being special-cased: a value that
 * comes back around a second time is a cycle, not a measurement. Settle on the
 * smaller of the two — that is the layout that is guaranteed to leave the
 * pagination and footer on screen — and stop until something resets the latch.
 *
 * @returns {{accept: (current: number, fit: number) => number|null, reset: () => void}}
 */
export function createFitLatch() {
  const applied = new Set();
  let latched = false;
  return {
    /**
     * @param {number} current  the per_page the grid was loaded with.
     * @param {number} fit  what the viewport measures as fitting now.
     * @returns {number|null} the per_page to apply, or null to leave it alone.
     */
    accept(current, fit) {
      if (latched || fit === current) return null;
      if (applied.has(fit)) {
        latched = true;
        // Shrinking is always safe; growing back into a value we have already
        // been chased away from is what the cycle is made of.
        return fit < current ? fit : null;
      }
      applied.add(fit);
      return fit;
    },
    /** Forget the cycle — a resize or a zoom step is a genuinely new decision. */
    reset() {
      applied.clear();
      latched = false;
    },
  };
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

  // Every viewport is measured, landscape phones and tablets included. This used
  // to short-circuit to `floor` (the posts_per_page setting) on the argument
  // that a landscape grid fans into a few columns and "a couple of rows already
  // fill the viewport" — which is true of the width and backwards about the
  // height. A phone on its side is ~390px tall and a card floors at
  // --post-cardhas-image-min-height (220px), so a floor of 6 laid out 2×3 and
  // asked a 390px window to show 724px of grid. Measuring gives it the one row
  // that actually fits; the rest is what pagination is for.
  let cols;
  let rowH;
  let gap;
  let top;
  // The grid's own width, which is the width of a full-row card (the hero) and,
  // divided by the columns, of a regular one — see applyCardImageSizes.
  let gridW = 0;
  let reserve = pluginHost.hasSlot('footer') ? FOOTER_FALLBACK : 0;

  if (gridEl && gridEl.isConnected) {
    const cs = window.getComputedStyle(gridEl);
    cols = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length || 1;
    gap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 0;
    gridW = gridEl.getBoundingClientRect().width;
    // Row height = the tallest regular (non-featured) slot. The grid stretches
    // every card in a row to the tallest, so a single short text card would
    // under-measure the row and over-request posts (footer off-screen); the
    // featured hero spans a full row and is ~2x taller, so it would do the
    // opposite. Taking the max of the regular slots is stable regardless of how
    // many posts are currently rendered or where the hero sits — no feedback
    // loop. Falls back to the token when only the hero is present.
    if (zoomCols) {
      // Zoomed cards stretch to fill their 1fr row, so measuring a slot's
      // height feeds back: taller row → fewer rows computed → refetch → even
      // taller rows. Use the square base (column width) instead — the leftover
      // after fitting squares becomes a modest per-row stretch, not a spiral.
      rowH = (gridW - (cols - 1) * gap) / cols;
    } else {
      const slots = [...gridEl.querySelectorAll('.post-card-slot:not(.featured-post)')];
      rowH =
        slots.reduce((m, s) => Math.max(m, s.getBoundingClientRect().height), 0) ||
        tokenPx('var(--post-cardhas-image-min-height)', gridEl);
    }
    top = gridEl.getBoundingClientRect().top;
    reserve = belowGridReserve(gridEl);
  } else {
    const maxW = tokenPx('var(--content-max-width)');
    const pad = tokenPx('var(--spacing-md)');
    gap = tokenPx('var(--spacing-xl)');
    const width = Math.min(window.innerWidth, maxW || window.innerWidth) - 2 * pad;
    gridW = width;
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

  // Cards are sized by their grid track, so the track is also what their
  // images have to fill. Published before the rowH bail-out below: an
  // unmeasurable row height says nothing about the width.
  if (gridEl && gridEl.isConnected) measureCardImageSizes(gridEl);
  else applyCardImageSizes((gridW - (cols - 1) * gap) / cols, gridW);

  if (!rowH) {
    _cache = floor;
    return floor;
  }

  const avail = Math.max(rowH, window.innerHeight - top - reserve);
  // Floor (not round): a partial row would spill over the reserved footer band.
  // Zoom is the exception: its rows are minmax(0, 1fr) so they compress as
  // happily as they stretch — round to whichever count is nearer square
  // (flooring a 1.9-row fit would leave one row of double-height sausages).
  const fit = (avail + gap) / (rowH + gap);
  const rows = Math.max(1, zoomCols ? Math.round(fit) : Math.floor(fit));
  // Hold the grid to this shape from now on — see applyRowsVar.
  applyRowsVar(zoomCols ? rows : 0);
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

/**
 * The page to land on when per_page changes from `current` to `next`, chosen so
 * the first post currently on screen is still on it.
 *
 * The feed's two halves are indexed from their shared boundary in opposite
 * directions: page 1 is offset 0 into the published list, page 0 is offset 0
 * into the scheduled queue running the other way (see publishing.md). A
 * non-positive page is therefore re-fitted on its own side rather than as a
 * continuation of the same run. Feeds without a queue (search) never pass one.
 *
 * @param {number} page     Current page — 1-based, or 0/negative in the queue.
 * @param {number} current  per_page the page was loaded at.
 * @param {number} next     per_page it is being re-fitted to.
 * @returns {number}
 */
export function refitPage(page, current, next) {
  if (page < 1) return -Math.floor((-page * current) / next);
  return Math.floor(((page - 1) * current) / next) + 1;
}
