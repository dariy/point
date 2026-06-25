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

const MAX_PER_PAGE = 60;
// Mobile and tablet viewports (iPad landscape is 1024px) get a fixed page size;
// only wider desktop layouts fan out into enough columns to be worth measuring.
const TABLET_MAX_WIDTH = 1024;
let _cache = 0;

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

  if (gridEl && gridEl.isConnected) {
    const cs = window.getComputedStyle(gridEl);
    cols = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length || 1;
    gap = parseFloat(cs.rowGap) || parseFloat(cs.gap) || 0;
    // A real card is the most faithful row height; the featured card spans a
    // full row and is taller, so prefer a regular one. Fall back to the token.
    const card =
      gridEl.querySelector('.post-card-slot:not(.featured-post) .post-card') ||
      gridEl.querySelector('.post-card');
    rowH = card
      ? card.getBoundingClientRect().height
      : tokenPx('var(--post-cardhas-image-min-height)', gridEl);
    top = gridEl.getBoundingClientRect().top;
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

  const avail = Math.max(rowH, window.innerHeight - top);
  const rows = Math.max(1, Math.round((avail + gap) / (rowH + gap)));
  const value = Math.min(MAX_PER_PAGE, Math.max(floor, cols * rows));
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
