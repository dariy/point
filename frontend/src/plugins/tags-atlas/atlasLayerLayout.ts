/**
 * atlasLayerLayout — the geometry of the map layer in `mapList` and `map`.
 *
 * It owns one map container on `document.body`. CSS reads the state from
 * `body[data-atlas-layer]` and places the map, the card row and the handle.
 * This module only measures what CSS cannot know, and publishes it as
 * custom properties on `body`:
 *
 *   --atlas-layer-header-h   bottom edge of the header, in px
 *   --atlas-layer-gap        gap between two cards (SHEET_GAP_PX)
 *   --atlas-layer-aspect     card width over card height (CARD_ASPECT)
 *
 * The map container starts empty. The map itself loads later, on the first
 * change out of `list`.
 */

import { setAtlasLayerState } from './atlasLayerState.ts';
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

  const header = document.getElementById('header-mount');
  const measure = () => {
    const bottom = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
    body.style.setProperty('--atlas-layer-header-h', `${bottom}px`);
  };
  measure();
  const ro = typeof ResizeObserver === 'function' && header ? new ResizeObserver(measure) : null;
  if (header) ro?.observe(header);
  window.addEventListener('resize', measure);

  return () => {
    ro?.disconnect();
    window.removeEventListener('resize', measure);
    map.remove();
    // Leaving the list page must not leave the footer hidden on the next page.
    if (body.hasAttribute('data-atlas-layer')) setAtlasLayerState('list', body);
    body.style.removeProperty('--atlas-layer-header-h');
    body.style.removeProperty('--atlas-layer-gap');
    body.style.removeProperty('--atlas-layer-aspect');
  };
}
