/**
 * atlasLayerLayout — the geometry of the map layer in `mapList` and `map`.
 *
 * It owns one map container on `document.body`. CSS reads the state from
 * `body[data-atlas-layer]` and places the map, the card row and the handle.
 * This module only measures what CSS cannot know, and publishes it as
 * custom properties on `body`:
 *
 *   --atlas-layer-header-h   bottom edge of the header, in px
 *   --atlas-layer-top        bottom edge of the header (the timeline is part of it), in px
 *   --atlas-layer-gap        gap between two cards (SHEET_GAP_PX)
 *   --atlas-layer-aspect     card width over card height (CARD_ASPECT)
 *
 * It also keeps the state in the URL (`?atlas=…`, by `history.replaceState`), reads
 * it on mount, and leaves the list URL for the post page when a card opens a post.
 *
 * The map container starts empty. The map itself loads later, on the first
 * change out of `list`.
 */

import { getAtlasLayerState, replaceSearch, searchWithState, setAtlasLayerState, stateFromSearch } from './atlasLayerState.ts';
import { markAtlasOpen } from '../../utils/atlasReturn.ts';
import { CARD_ASPECT, SHEET_GAP_PX } from './AtlasSheet.ts';

const MAP_CLASS = 'atlas-layer-map';

/** Create the map container and start tracking the header. Returns a cleanup. */
export function mountAtlasLayerLayout(body: HTMLElement = document.body): () => void {
  const existing = body.querySelector<HTMLElement>(`:scope > .${MAP_CLASS}`);
  const map = existing ?? document.createElement('div');
  if (!existing) {
    map.className = MAP_CLASS;
    map.setAttribute('aria-label', 'Map of the posts in this list');
    body.append(map);
  }

  body.style.setProperty('--atlas-layer-gap', `${SHEET_GAP_PX}px`);
  body.style.setProperty('--atlas-layer-aspect', String(CARD_ASPECT));

  // The URL names the state on arrival. A state change after that rewrites the
  // query in place: one history entry, however many swipes.
  setAtlasLayerState(stateFromSearch(location.search), body);
  const mo = new MutationObserver(() => replaceSearch(searchWithState(location.search, getAtlasLayerState(body))));
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
    // In `map` the footer is a fixed strip under the handle. No footer plugin leaves the mount empty: 0px.
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
    mo.disconnect();
    document.removeEventListener('click', onCardClick, true);
    ro?.disconnect();
    domObserver.disconnect();
    window.removeEventListener('resize', measure);
    map.remove();
    // Leaving the list page must not leave the footer hidden on the next page.
    if (body.hasAttribute('data-atlas-layer')) setAtlasLayerState('list', body);
    body.style.removeProperty('--atlas-layer-header-h');
    body.style.removeProperty('--atlas-layer-top');
    body.style.removeProperty('--atlas-layer-footer-h');
    body.style.removeProperty('--atlas-layer-gap');
    body.style.removeProperty('--atlas-layer-aspect');
  };
}
