/**
 * atlasLayerMap — the map inside the layer. Only the ocean (atlasOcean.ts)
 * makes one, and it keeps it until the page unloads or `tags-atlas` is off.
 *
 * The map is lazy. Nothing loads (no Leaflet, no data, no tiles) until the
 * first `show()`. Then the controller loads Leaflet, builds the map and mounts
 * AtlasPlaces on it: country shapes, selectable geo-tags and the tag-post graph.
 * The map is never rebuilt. It calls `invalidateSize` whenever its box changes.
 */

import { loadLeaflet, TILE_ATTR, TILE_DARK, TILE_LIGHT, TILE_MAX_NATIVE_ZOOM } from '../../utils/leaflet.ts';
import { navigate } from '../../utils/helpers.ts';
import { ViewContext } from '../../utils/viewContext.ts';
import { AtlasPlaces } from './AtlasPlaces.ts';
import { getAtlasLayerState, isAtlasListPath, replaceSearch, searchWithView, viewFromSearch } from './atlasLayerState.ts';

import type { LeafletRef } from '../../utils/leaflet.ts';

export interface AtlasLayerMapOptions {
  /** the map container */
  container: HTMLElement;
}

export interface AtlasLayerMapController {
  /** The map is on screen: build it on the first call, then re-measure. */
  show(): void;
  /** Re-measure the map box. */
  resize(): void;
  /**
   * The map goes off screen for another page. Its hidden box changes size, and
   * at a low zoom Leaflet's `maxBounds` would move the centre for it. So a
   * parked map ignores resizes, and the next `show()` puts the kept view back.
   */
  park(): void;
  /**
   * A new list page shows the map: bring the selection and the URL viewport in
   * line with the new route.
   */
  route(): void;
  destroy(): void;
}

function isDarkTheme(): boolean {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * Client-side move to a geo-tag's page, or home for `null`. The router keeps the
 * view mode; the year range travels as `?timeline=`.
 */
function openPlace(slug: string | null): void {
  const years = ViewContext.current().years;
  const path = slug ? `/tags/${encodeURIComponent(slug)}` : '/';
  if (location.pathname === path) return;
  navigate(path + (years ? `?timeline=${years[0]}-${years[1]}` : ''));
}

/** Start the controller. It loads nothing until the first `show()`. */
export function mountAtlasLayerMap(
  opts: AtlasLayerMapOptions,
  body: HTMLElement = document.body,
): AtlasLayerMapController {
  let map: any = null;
  let tiles: any = null;
  let places: AtlasPlaces | null = null;
  let loading = false;
  let dead = false;
  let ro: ResizeObserver | null = null;
  let parked: { center: unknown; zoom: number } | null = null;
  const isAlive = () => !dead;

  const writeView = () => {
    if (!map || getAtlasLayerState(body) === 'list') return;
    if (!isAtlasListPath(location.pathname + location.search)) return;
    const c = map.getCenter();
    replaceSearch(searchWithView(location.search, { lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  };

  const onTheme = () => tiles?.setUrl(isDarkTheme() ? TILE_DARK : TILE_LIGHT);

  async function build() {
    if (map || loading) return;
    loading = true;
    let L: LeafletRef;
    try {
      L = await loadLeaflet();
    } catch {
      loading = false;
      return;
    }
    loading = false;
    if (!isAlive()) return;
    // zoomAnimation is off: Leaflet 1.9.4 animates the country shapes (an SVG
    // overlay) with a transform that drifts from the tile pane for this map.
    map = L.map(opts.container, {
      minZoom: 2,
      maxBounds: [[-90, -180], [90, 180]],
      maxBoundsViscosity: 1.0,
      zoomAnimation: false,
    });
    // A reload or a return from a post brings the viewport back from the URL.
    const view = viewFromSearch(location.search);
    map.setView(view ? [view.lat, view.lng] : [20, 0], view ? view.zoom : 2);
    map.on('moveend', writeView);
    tiles = L.tileLayer(isDarkTheme() ? TILE_DARK : TILE_LIGHT, {
      attribution: TILE_ATTR,
      maxZoom: 18,
      maxNativeZoom: TILE_MAX_NATIVE_ZOOM,
      noWrap: true,
      bounds: [[-90, -180], [90, 180]],
    }).addTo(map);
    document.addEventListener('themechange', onTheme);

    places = new AtlasPlaces({
      L,
      map,
      root: opts.container,
      isAlive,
      // The picked geo-tag opens as a tag page; clearing it goes home.
      onSelect: (tag) => openPlace(tag?.slug ?? null),
    });
    // A viewport from the URL beats the opening fit-to-places.
    places._didFitBounds = !!view;
    map.invalidateSize();
    // A parked map ignores its hidden box (see `park`).
    ro = new ResizeObserver(() => { if (!parked) map?.invalidateSize(); });
    ro.observe(opts.container);
    void places.start();
  }

  return {
    show() {
      if (dead) return;
      if (!map) {
        void build();
        return;
      }
      if (parked) {
        // The box can differ from the one the map left (the window changed
        // size). Re-measure without a pan, then put the kept view back.
        const { center, zoom } = parked;
        parked = null;
        map.invalidateSize({ pan: false });
        map.setView(center, zoom, { animate: false });
      } else {
        map.invalidateSize();
      }
    },
    resize() {
      if (!parked) map?.invalidateSize();
    },
    park() {
      if (map && !parked) parked = { center: map.getCenter(), zoom: map.getZoom() };
    },
    route() {
      places?.syncToRoute();
      // The router carried `?view=` to the new URL, but not the viewport.
      writeView();
    },
    destroy() {
      dead = true;
      ro?.disconnect();
      document.removeEventListener('themechange', onTheme);
      places?.destroy();
      map?.remove();
      map = null;
    },
  };
}
