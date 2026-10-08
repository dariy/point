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

const URL_PARAM = 'view';
const LEGACY_URL_PARAM = 'atlas';
const STORAGE_KEY = 'atlasLayerState';
const URL_VALUE: Readonly<Record<AtlasLayerState, string>> = { list: 'list', mapList: 'split', map: 'map' };
const LEGACY_URL_VALUE: Readonly<Record<AtlasLayerState, string | null>> = { list: null, mapList: 'list-map', map: 'map' };

/** The state a query string names (`?view=list|split|map`), or null when absent or invalid. */
export function stateFromSearchOrNull(search: string): AtlasLayerState | null {
  const params = new URLSearchParams(search);
  const value = params.get(URL_PARAM);
  const found = ORDER.find((s) => URL_VALUE[s] === value);
  if (found) return found;
  // Links made before `view` took the mode used `?atlas=list-map|map`.
  const legacy = params.get(LEGACY_URL_PARAM);
  return legacy ? (ORDER.find((s) => LEGACY_URL_VALUE[s] === legacy) ?? null) : null;
}

/** The state a query string names. Absent or invalid gives `list`. */
export function stateFromSearch(search: string): AtlasLayerState {
  return stateFromSearchOrNull(search) ?? 'list';
}

/** The state saved by the last change, or null when none is saved or the value is invalid. */
export function readSavedState(storage: Pick<Storage, 'getItem'> | null = safeStorage()): AtlasLayerState | null {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return ORDER.find((s) => s === value) ?? null;
  } catch {
    return null;
  }
}

/** Save the state for the next page load. A blocked store is ignored. */
export function saveState(state: AtlasLayerState, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, state);
  } catch {
    /* private mode or full: the URL still holds the state */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The state on page load: the URL, then the saved state, then `list`. */
export function initialState(search: string, storage?: Pick<Storage, 'getItem'> | null): AtlasLayerState {
  return stateFromSearchOrNull(search) ?? readSavedState(storage) ?? 'list';
}

/** `search` with the `view` parameter set for `state`. Other parameters stay. */
export function searchWithState(search: string, state: AtlasLayerState): string {
  const params = new URLSearchParams(search);
  params.delete(LEGACY_URL_PARAM);
  params.set(URL_PARAM, URL_VALUE[state]);
  return `?${params.toString()}`;
}

/** A map viewport: centre and zoom. */
export interface AtlasView {
  lat: number;
  lng: number;
  zoom: number;
}

const VIEW_PARAM = 'at';

/** The viewport in `?at=lat,lng,zoom`, or null when absent or malformed. */
export function viewFromSearch(search: string): AtlasView | null {
  const parts = (new URLSearchParams(search).get(VIEW_PARAM) ?? '').split(',');
  if (parts.length !== 3) return null;
  const [lat, lng, zoom] = parts.map(Number) as [number, number, number];
  if (![lat, lng, zoom].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, zoom };
}

/** `search` with the viewport set in `at`. Other parameters stay. */
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

/**
 * `path` with the `view` parameter for `state`, when `path` is a post list page
 * (`/` or `/tags/<slug>`, not a post inside a tag) that names no state of its own.
 * Any other path returns `path` unchanged. This is how a tag link keeps the view
 * mode: the next page reads the state from its URL on mount.
 */
export function carryStateToPath(path: string, state: AtlasLayerState): string {
  const url = new URL(path, 'http://x');
  const isList = url.pathname === '/' || /^\/tags\/[^/]+\/?$/.test(url.pathname);
  if (!isList || url.searchParams.has('slug') || stateFromSearchOrNull(url.search)) return path;
  return url.pathname + searchWithState(url.search, state) + url.hash;
}
