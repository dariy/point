/**
 * atlasLayerLayout — the geometry of the map layer in `mapList` and `map`.
 *
 * The map container on `document.body` belongs to the ocean (atlasOcean.ts),
 * which mounts this layout for each list page. CSS reads the state from
 * `body[data-atlas-layer]` and places the map, the card row and the handle.
 * This module only measures what CSS cannot know, and publishes it as
 * custom properties on `body`:
 *
 *   --atlas-layer-header-h   bottom edge of the header, in px
 *   --atlas-layer-top        bottom edge of the header (the timeline is part of it), in px
 *   --atlas-layer-gap        gap between two cards (SHEET_GAP_PX)
 *   --atlas-layer-aspect     card width over card height (CARD_ASPECT)
 *
 * Touch input in landscape sets `body[data-atlas-side]` (watchAtlasSide). In
 * `mapList` CSS then puts a square map on the left, and the header, the list
 * column and the footer on the right (`--atlas-layer-map-w`, atlas.css).
 *
 * It also keeps the state in the URL (`?view=…`, by `history.replaceState`), reads
 * it on mount, and leaves the list URL for the post page when a card opens a post.
 */

import { getAtlasLayerState, replaceSearch, searchWithState, saveState, setAtlasLayerState, initialState, stateFromSearchOrNull } from './atlasLayerState.ts';
import { markAtlasOpen } from '../../utils/atlasReturn.ts';
import { CARD_ASPECT, SHEET_GAP_PX } from './AtlasSheet.ts';
import { hasFinePointer } from '../../utils/pointerMode.ts';

/** The body attribute of the touch landscape layout. */
export const ATLAS_SIDE_ATTR = 'data-atlas-side';

const LANDSCAPE_QUERY = '(orientation: landscape)';
const FINE_QUERY = '(hover: hover) and (pointer: fine)';

/** What watchAtlasSide reads. Tests replace it. */
export interface AtlasSideEnv {
  /** True when a mouse or a trackpad drives the page (pointerMode.ts::hasFinePointer). */
  fine(): boolean;
  landscape(): boolean;
  /** Call `fn` when one of the two can change. Returns a stop. */
  observe(fn: () => void): () => void;
}

function defaultSideEnv(): AtlasSideEnv {
  return {
    fine: hasFinePointer,
    landscape: () => window.matchMedia?.(LANDSCAPE_QUERY).matches === true,
    observe(fn) {
      // pointerMode.ts moves the `pointer-fine` class on <html> with the input in use.
      // A test DOM can lack MutationObserver: then only the queries and resize count.
      const mo = typeof MutationObserver === 'function' ? new MutationObserver(fn) : null;
      mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      const queries = [LANDSCAPE_QUERY, FINE_QUERY].map((q) => window.matchMedia?.(q)).filter(Boolean) as MediaQueryList[];
      for (const q of queries) q.addEventListener?.('change', fn);
      window.addEventListener('resize', fn);
      return () => {
        mo?.disconnect();
        for (const q of queries) q.removeEventListener?.('change', fn);
        window.removeEventListener('resize', fn);
      };
    },
  };
}

/** True for the touch landscape layout: no fine pointer, and a landscape viewport. */
export function atlasSide(env: Pick<AtlasSideEnv, 'fine' | 'landscape'>): boolean {
  return !env.fine() && env.landscape();
}

/**
 * Keep `body[data-atlas-side]` in step with the input and the orientation.
 * A rotation or a change of input moves the layout without a reload.
 * Returns a stop, which removes the attribute.
 */
export function watchAtlasSide(body: HTMLElement = document.body, env: AtlasSideEnv = defaultSideEnv()): () => void {
  const sync = () => {
    const side = atlasSide(env);
    if (side === body.hasAttribute(ATLAS_SIDE_ATTR)) return;
    if (side) body.setAttribute(ATLAS_SIDE_ATTR, '');
    else body.removeAttribute(ATLAS_SIDE_ATTR);
  };
  sync();
  const stop = env.observe(sync);
  return () => {
    stop();
    body.removeAttribute(ATLAS_SIDE_ATTR);
  };
}

/**
 * Call `fn(side)` at once, and again each time the side verdict changes (a
 * rotation, or a change of input). The post viewer uses it for its own touch
 * landscape layout (ImmersiveSheetViewer.ts), with the same test as the map
 * layer. Returns a stop.
 */
export function onAtlasSide(fn: (side: boolean) => void, env: AtlasSideEnv = defaultSideEnv()): () => void {
  let last: boolean | null = null;
  const sync = () => {
    const side = atlasSide(env);
    if (side === last) return;
    last = side;
    fn(side);
  };
  sync();
  return env.observe(sync);
}

/** Read the state from the URL and start tracking the header. Returns a cleanup. */
export function mountAtlasLayerLayout(body: HTMLElement = document.body): () => void {
  body.style.setProperty('--atlas-layer-gap', `${SHEET_GAP_PX}px`);
  body.style.setProperty('--atlas-layer-aspect', String(CARD_ASPECT));
  const stopSide = watchAtlasSide(body);

  // The URL names the state on arrival. A state change after that rewrites the
  // query in place: one history entry, however many swipes.
  // The URL wins, then the state saved by the last change, then `list`.
  const first = initialState(location.search);
  setAtlasLayerState(first, body);
  if (first !== 'list' && !stateFromSearchOrNull(location.search)) replaceSearch(searchWithState(location.search, first));
  const mo = new MutationObserver(() => {
    const state = getAtlasLayerState(body);
    saveState(state);
    replaceSearch(searchWithState(location.search, state));
  });
  mo.observe(body, { attributes: true, attributeFilter: ['data-atlas-layer'] });

  // A card or link that opens a page from `mapList` or `map` leaves the list URL, so closing the post returns to it.
  const onCardClick = (e: MouseEvent) => {
    if (getAtlasLayerState(body) === 'list') return;
    const link = (e.target as Element | null)?.closest?.('#grid-mount .post-card, #grid-mount a[href]');
    if (link) markAtlasOpen({ returnUrl: location.pathname + location.search });
  };
  document.addEventListener('click', onCardClick, true);

  const header = document.getElementById('header-mount');
  let footerMount: HTMLElement | null = null;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
  const measure = () => {
    const headerBottom = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
    // In `mapList`, `map` and a drag the footer is the fixed bottom bar under the strip and the handle. No footer plugin leaves the mount empty: 0px.
    const fm = document.getElementById('footer-mount');
    if (fm !== footerMount) {
      if (footerMount) ro?.unobserve(footerMount);
      footerMount = fm;
      if (fm) ro?.observe(fm);
    }
    const footerHeight = fm ? Math.round(fm.getBoundingClientRect().height) : 0;
    body.style.setProperty('--atlas-layer-footer-h', `${footerHeight}px`);
    body.style.setProperty('--atlas-layer-header-h', `${headerBottom}px`);
    body.style.setProperty('--atlas-layer-top', `${headerBottom}px`);
  };
  measure();
  if (header) ro?.observe(header);
  const domObserver = new MutationObserver(measure);
  domObserver.observe(document.getElementById('app') ?? body, { childList: true, subtree: true });
  window.addEventListener('resize', measure);

  return () => {
    stopSide();
    mo.disconnect();
    document.removeEventListener('click', onCardClick, true);
    ro?.disconnect();
    domObserver.disconnect();
    window.removeEventListener('resize', measure);
    // Leaving the list page must not leave the footer hidden on the next page.
    if (body.hasAttribute('data-atlas-layer')) setAtlasLayerState('list', body);
    body.style.removeProperty('--atlas-layer-header-h');
    body.style.removeProperty('--atlas-layer-top');
    body.style.removeProperty('--atlas-layer-footer-h');
    body.style.removeProperty('--atlas-layer-gap');
    body.style.removeProperty('--atlas-layer-aspect');
  };
}
