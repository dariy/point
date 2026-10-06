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

const URL_PARAM = 'atlas';
const URL_VALUE: Readonly<Record<AtlasLayerState, string | null>> = { list: null, mapList: 'list-map', map: 'map' };

/** The state a query string names (`?atlas=map`, `?atlas=list-map`). Anything else gives `list`. */
export function stateFromSearch(search: string): AtlasLayerState {
  const value = new URLSearchParams(search).get(URL_PARAM);
  return ORDER.find((s) => URL_VALUE[s] === value) ?? 'list';
}

/** `search` with the `atlas` parameter set for `state` (removed for `list`). Other parameters stay. */
export function searchWithState(search: string, state: AtlasLayerState): string {
  const params = new URLSearchParams(search);
  const value = URL_VALUE[state];
  if (value) params.set(URL_PARAM, value);
  else params.delete(URL_PARAM);
  const out = params.toString();
  return out ? `?${out}` : '';
}

/** A map viewport: centre and zoom. */
export interface AtlasView {
  lat: number;
  lng: number;
  zoom: number;
}

const VIEW_PARAM = 'view';

/** The viewport in `?view=lat,lng,zoom`, or null when absent or malformed. */
export function viewFromSearch(search: string): AtlasView | null {
  const parts = (new URLSearchParams(search).get(VIEW_PARAM) ?? '').split(',');
  if (parts.length !== 3) return null;
  const [lat, lng, zoom] = parts.map(Number) as [number, number, number];
  if (![lat, lng, zoom].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, zoom };
}

/** `search` with the viewport set in `view`. Other parameters stay. */
export function searchWithView(search: string, view: AtlasView): string {
  const params = new URLSearchParams(search);
  params.set(VIEW_PARAM, `${view.lat.toFixed(4)},${view.lng.toFixed(4)},${view.zoom}`);
  return `?${params.toString()}`;
}

/** Replace the current history entry's query string. No new entry, no route render. */
export function replaceSearch(search: string): void {
  if (search === location.search) return;
  history.replaceState(history.state, '', location.pathname + search + location.hash);
}
