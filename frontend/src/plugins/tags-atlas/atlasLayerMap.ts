/**
 * atlasLayerMap — the map inside the layer.
 *
 * The map is lazy. Nothing loads (no Leaflet, no data, no tiles) while the page
 * stays in `list`. On the first change out of `list` the controller loads
 * Leaflet, builds the map and mounts AtlasPlaces on it: country shapes,
 * selectable geo-tags and the tag-post graph. The map is never rebuilt. It
 * calls `invalidateSize` whenever its box changes (a state change or a drag).
 */

import { loadLeaflet, TILE_ATTR, TILE_DARK, TILE_LIGHT, TILE_MAX_NATIVE_ZOOM } from '../../utils/leaflet.ts';
import { AtlasPlaces } from './AtlasPlaces.ts';
import { getAtlasLayerState, replaceSearch, searchWithView, viewFromSearch } from './atlasLayerState.ts';

import type { LeafletRef } from '../../utils/leaflet.ts';

export interface AtlasLayerMapOptions {
  /** the map container */
  container: HTMLElement;
  /** false once the host unmounted */
  isAlive: () => boolean;
}

export interface AtlasLayerMapController {
  destroy(): void;
}

function isDarkTheme(): boolean {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Start the controller. It waits for the first state other than `list`. */
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
    if (dead || !opts.isAlive()) return;
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
    map.on('moveend', () => {
      if (getAtlasLayerState(body) === 'list') return;
      const c = map.getCenter();
      replaceSearch(searchWithView(location.search, { lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
    });
    tiles = L.tileLayer(isDarkTheme() ? TILE_DARK : TILE_LIGHT, {
      attribution: TILE_ATTR,
      maxZoom: 18,
      maxNativeZoom: TILE_MAX_NATIVE_ZOOM,
      noWrap: true,
      bounds: [[-90, -180], [90, 180]],
    }).addTo(map);
    document.addEventListener('themechange', onTheme);

    places = new AtlasPlaces({ L, map, root: opts.container, isAlive: opts.isAlive });
    // A viewport from the URL beats the opening fit-to-places.
    places._didFitBounds = !!view;
    map.invalidateSize();
    ro = new ResizeObserver(() => map?.invalidateSize());
    ro.observe(opts.container);
    void places.start();
  }

  const sync = () => {
    if (getAtlasLayerState(body) !== 'list') void build();
    else map?.invalidateSize();
  };
  const mo = new MutationObserver(sync);
  mo.observe(body, { attributes: true, attributeFilter: ['data-atlas-layer'] });
  sync();

  return {
    destroy() {
      dead = true;
      mo.disconnect();
      ro?.disconnect();
      document.removeEventListener('themechange', onTheme);
      places?.destroy();
      map?.remove();
      map = null;
    },
  };
}
