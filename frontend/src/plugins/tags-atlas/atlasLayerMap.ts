/**
 * atlasLayerMap — the map inside the layer. Only the ocean (atlasOcean.ts)
 * makes one, and it keeps it until the page unloads or `tags-atlas` is off.
 *
 * The map is lazy. Nothing loads (no Leaflet, no data, no tiles) until the
 * first `show()` or `warm()`. Then the controller loads Leaflet, builds the map and mounts
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
  /**
   * The map goes off screen: the `list` state, or a page that is not a list.
   * Its hidden box has another size, and at a low zoom Leaflet's `maxBounds`
   * would move the centre for it. So a parked map keeps its view. A resize of
   * the hidden box does nothing; a resize while the box is visible (a handle
   * drag from `list`) re-measures and starts again from the kept view. The next
   * `show()` puts the kept view back.
   */
  park(): void;
  /**
   * Build the map off screen (the `list` state), so the first `show()` only
   * shows it. Leaflet, the tiles and the places load into the hidden box. The
   * map stays parked: a viewport from the URL is kept for the first `show()`.
   */
  warm(): void;
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
  // The last call was show() (true) or park()/warm() (false).
  let shown = false;
  const isAlive = () => !dead;

  const writeView = () => {
    if (!map || getAtlasLayerState(body) === 'list') return;
    if (!isAtlasListPath(location.pathname + location.search)) return;
    const c = map.getCenter();
    replaceSearch(searchWithView(location.search, { lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  };

  const onTheme = () => tiles?.setUrl(isDarkTheme() ? TILE_DARK : TILE_LIGHT);

  /** Re-measure without a pan, then set the kept view (see `park`). */
  const restore = (kept: { center: unknown; zoom: number }) => {
    map.invalidateSize({ pan: false });
    map.setView(kept.center, kept.zoom, { animate: false });
  };

  const onResize = () => {
    if (!map) return;
    if (!parked) {
      map.invalidateSize();
      return;
    }
    // A parked map is hidden (nothing to do), or a handle drag from `list`
    // shows it. A drag needs the true size, but its view comes from the kept
    // one, not from the last clamp. The kept view stays for the next `show()`.
    if (getComputedStyle(opts.container).visibility === 'visible') restore(parked);
  };

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
    // A warm build is off screen, in a box larger than the mapList box. At a
    // low zoom `maxBounds` can move the URL centre for it, and a fit-to-places
    // fits the wrong box. So the first show() sets the view: the URL view is
    // kept for it, or the fit waits for it.
    if (!shown) {
      if (view) parked = { center: [view.lat, view.lng], zoom: view.zoom };
      else places.holdFit();
    }
    map.invalidateSize();
    ro = new ResizeObserver(onResize);
    ro.observe(opts.container);
    void places.start();
  }

  return {
    show() {
      if (dead) return;
      shown = true;
      if (!map) {
        void build();
        return;
      }
      if (parked) {
        // The box can differ from the one the map left (the window changed
        // size). Re-measure, then put the kept view back.
        const kept = parked;
        parked = null;
        restore(kept);
      } else {
        map.invalidateSize();
      }
      places?.releaseFit();
    },
    park() {
      // Keep the view only when a shown map goes off screen. A map that was
      // never shown (a warm build) is not parked here: its fit-to-places can
      // land after this call, and the first show() must keep that fit.
      if (map && shown && !parked) parked = { center: map.getCenter(), zoom: map.getZoom() };
      shown = false;
    },
    warm() {
      if (dead || map) return;
      void build();
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
