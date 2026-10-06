/**
 * atlasLayerState — the three states of the map layer on post list pages.
 *
 *   list     the page as it is, plus a grab handle
 *   mapList  the map above a short strip of post cards
 *   map      the map fills the space below the header
 *
 * The transitions are pure. The current state lives on `document.body` as
 * `data-atlas-layer`, and CSS reads only that attribute.
 */

export type AtlasLayerState = 'list' | 'mapList' | 'map';

const ORDER: readonly AtlasLayerState[] = ['list', 'mapList', 'map'];

/** One state toward "map only". Stops at `map`. */
export function next(state: AtlasLayerState): AtlasLayerState {
  return ORDER[Math.min(ORDER.indexOf(state) + 1, ORDER.length - 1)]!;
}

/** One state toward "list". Stops at `list`. */
export function prev(state: AtlasLayerState): AtlasLayerState {
  return ORDER[Math.max(ORDER.indexOf(state) - 1, 0)]!;
}

/** One state forward, and from `map` back to `list`. */
export function cycle(state: AtlasLayerState): AtlasLayerState {
  return state === 'map' ? 'list' : next(state);
}

/** Read the state from `body[data-atlas-layer]`. Unknown or missing gives `list`. */
export function getAtlasLayerState(body: HTMLElement = document.body): AtlasLayerState {
  const value = body.getAttribute('data-atlas-layer');
  return ORDER.find((s) => s === value) ?? 'list';
}

/** Write the state to `body[data-atlas-layer]`. */
export function setAtlasLayerState(state: AtlasLayerState, body: HTMLElement = document.body): void {
  body.setAttribute('data-atlas-layer', state);
}

/** Remove the attribute, for when the layer is not active. */
export function clearAtlasLayerState(body: HTMLElement = document.body): void {
  body.removeAttribute('data-atlas-layer');
}
