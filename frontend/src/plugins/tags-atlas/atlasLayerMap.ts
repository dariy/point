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
import type { Point } from './atlasOceanGeometry.ts';
import type { AtlasView } from './atlasLayerState.ts';

/** A map point. */
export interface LatLng {
  lat: number;
  lng: number;
}

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
   * line with the new route. `focusPostSlug` (a move from a post's map
   * widget) selects the route's place again and focuses that post's chip.
   */
  route(focusPostSlug?: string): void;
  /** Put `center` at the box centre at `zoom`, with no animation. Nothing before the build. */
  setView(center: LatLng, zoom: number): void;
  /**
   * A return to a list page from another page: the viewport in the page's URL
   * (`?at=`) is the view to show. A parked view that is the same (to the URL's
   * 4 decimals) stays, so the map does not move by the rounding. Another
   * parked view (one from a post's map widget) is replaced. Nothing before
   * the build: the build reads the URL.
   */
  useView(view: AtlasView): void;
  /**
   * The map is on screen through a window (atlasOcean.ts): the box keeps its
   * size, a clip shows part of it. Build the map on the first call. With
   * `center`, set the view so `center` sits `offset` px from the box centre (the
   * window centre), at `zoom` when given. A parked view stays parked for the next `show()` after a
   * `park()`; a `show()` straight from a window keeps the window's view.
   * The move into a window clears the place selection: the widget shows the
   * post's place, not the cloud of the tag page before it.
   */
  frame(center: LatLng | null, offset: Point, zoom?: number): void;
  /** Where `latLng` is now, from the box centre, in px. `null` before the build. */
  offsetOf(latLng: LatLng): Point | null;
  /** Move the view by `dx`, `dy` px, with no animation. */
  panBy(dx: number, dy: number): void;
  /**
   * In a window, a place selection (a marker, a shape, a key press) calls `fn`
   * and does not open the place's tag page. `null` sets the tag-page move back.
   */
  setWindowTap(fn: (() => void) | null): void;
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
  // The last call was frame(): the map shows through a window.
  let windowed = false;
  // A frame() before the build: applied when the map is built.
  let pendingFrame: { center: LatLng | null; offset: Point; zoom?: number } | null = null;
  let windowTap: (() => void) | null = null;
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

  /** Put `center` at `offset` px from the box centre, at `zoom` (default: the current zoom). */
  const centerAt = (center: LatLng, offset: Point, zoom?: number) => {
    const z = zoom ?? map.getZoom();
    const p = map.project([center.lat, center.lng], z);
    map.setView(map.unproject([p.x - offset.x, p.y - offset.y], z), z, { animate: false });
  };

  const onResize = () => {
    if (!map) return;
    // A window shows the map at its own view; the parked view waits for show().
    if (windowed) {
      map.invalidateSize({ pan: false });
      return;
    }
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
      // The picked geo-tag opens as a tag page; clearing it goes home. In a
      // window, a pick opens the full map instead (windowTap).
      onSelect: (tag) => {
        if (windowed && windowTap) {
          if (tag) windowTap();
          return;
        }
        openPlace(tag?.slug ?? null);
      },
    });
    // A viewport from the URL beats the opening fit-to-places.
    places._didFitBounds = !!view;
    // A warm build is off screen, in a box larger than the mapList box. At a
    // low zoom `maxBounds` can move the URL centre for it, and a fit-to-places
    // fits the wrong box. So the first show() sets the view: the URL view is
    // kept for it, or the fit waits for it.
    // A window build sets its own view (frame); it does not fit to places.
    if (windowed) places._didFitBounds = true;
    else if (!shown) {
      if (view) parked = { center: [view.lat, view.lng], zoom: view.zoom };
      else places.holdFit();
    }
    map.invalidateSize();
    if (windowed && pendingFrame?.center) centerAt(pendingFrame.center, pendingFrame.offset, pendingFrame.zoom);
    pendingFrame = null;
    ro = new ResizeObserver(onResize);
    ro.observe(opts.container);
    void places.start();
  }

  return {
    show() {
      if (dead) return;
      shown = true;
      pendingFrame = null;
      if (!map) {
        windowed = false;
        void build();
        return;
      }
      if (windowed) {
        // From a window to a full map: the clip grew over the same box, so
        // the window's view stays. The parked view is no longer needed.
        windowed = false;
        parked = null;
        map.invalidateSize({ pan: false });
      } else if (parked) {
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
      if (map && (shown || windowed) && !parked) parked = { center: map.getCenter(), zoom: map.getZoom() };
      shown = false;
      windowed = false;
      pendingFrame = null;
    },
    warm() {
      if (dead || map) return;
      void build();
    },
    frame(center, offset, zoom) {
      if (dead) return;
      if (!windowed) places?.clearSelection();
      windowed = true;
      shown = false;
      if (!map) {
        // A second frame() before the build keeps the first centre (a slot
        // that moves while Leaflet loads keeps its point).
        pendingFrame = { center: center ?? pendingFrame?.center ?? null, offset, zoom: zoom ?? pendingFrame?.zoom };
        void build();
        return;
      }
      map.invalidateSize({ pan: false });
      if (center) centerAt(center, offset, zoom);
    },
    offsetOf(latLng) {
      if (!map) return null;
      const p = map.latLngToContainerPoint([latLng.lat, latLng.lng]);
      const size = map.getSize();
      return { x: p.x - size.x / 2, y: p.y - size.y / 2 };
    },
    panBy(dx, dy) {
      map?.panBy([dx, dy], { animate: false });
    },
    setWindowTap(fn) {
      windowTap = fn;
    },
    setView(center, zoom) {
      map?.setView([center.lat, center.lng], zoom, { animate: false });
    },
    useView(view) {
      if (!map) return;
      const key = (lat: number, lng: number, z: number) => `${lat.toFixed(4)},${lng.toFixed(4)},${z}`;
      const want = key(view.lat, view.lng, view.zoom);
      const kept = parked as { center: { lat: number; lng: number }; zoom: number } | null;
      if (kept) {
        if (key(kept.center.lat, kept.center.lng, kept.zoom) !== want) parked = { center: [view.lat, view.lng], zoom: view.zoom };
        return;
      }
      const c = map.getCenter();
      if (key(c.lat, c.lng, map.getZoom()) !== want) map.setView([view.lat, view.lng], view.zoom, { animate: false });
    },
    route(focusPostSlug) {
      places?.syncToRoute(focusPostSlug);
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
