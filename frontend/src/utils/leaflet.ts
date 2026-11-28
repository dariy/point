import { setScriptSrc } from "./helpers.ts";
import { PRESS_SLOP_PX } from "./pointerMode.ts";

export const LEAFLET_JS = "/assets/vendor/leaflet/leaflet.js";
export const LEAFLET_CSS = "/assets/vendor/leaflet/leaflet.css";
export const COUNTRIES_GEOJSON = "/assets/vendor/leaflet/countries.geojson";
export const CA_PROVINCES_GEOJSON =
  "/assets/vendor/leaflet/canada-provinces.geojson";
export const US_STATES_GEOJSON = "/assets/vendor/leaflet/us-states.geojson";

// Esri's Light/Dark Gray Canvas basemaps: keyless, unwatermarked, and a matched
// light/dark pair, so the theme swap below is a URL change and not a CSS filter.
// (CARTO's basemaps served the same role until they began stamping keyless tiles
// with "API KEY REQUIRED".) Note the ArcGIS path order is {z}/{y}/{x}, and there
// are no {s} subdomains or {r} retina variants.
const ESRI_CANVAS = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
export const TILE_LIGHT = `${ESRI_CANVAS}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
export const TILE_DARK = `${ESRI_CANVAS}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
// Gray Canvas has no tiles past z16 — above it the service returns a "map data
// not available" placeholder. maxNativeZoom makes Leaflet upscale z16 instead,
// so the maps keep zooming to 18 (blurrier, but continuous).
export const TILE_MAX_NATIVE_ZOOM = 16;
export const TILE_ATTR =
  'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, DeLorme, NAVTEQ';

/**
 * A Leaflet object: the L namespace, a map, a layer or a marker. The vendored
 * Leaflet ships no type declarations, so this is the type of `window.L`.
 */
export type LeafletRef = NonNullable<Window['L']>;

/** Load Leaflet once; return the L global. */
export async function loadLeaflet(): Promise<LeafletRef> {
  if (window.L) return window.L;

  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);
  }

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    setScriptSrc(s, LEAFLET_JS);
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  return window.L;
}

/** Leaflet's own drag start for a mouse, px (the `Draggable` default). */
export const MOUSE_CLICK_TOLERANCE = 3;

/** The part of a Leaflet map that `setPressTolerance` uses. */
export interface PressMap {
  getContainer(): HTMLElement;
  dragging?: { _draggable?: { options?: { clickTolerance?: number } } };
}

/**
 * Set the drag start of a map for each gesture, from the pointer type.
 *
 * Leaflet starts a drag when a press moves `clickTolerance` px (|dx| + |dy|),
 * and a drag drops the click. A pencil tip or a fingertip skids more than 3 px
 * during a tap, so a pen or a touch press gets `PRESS_SLOP_PX`. A mouse keeps 3.
 * Leaflet has no public option for it: `Map.Drag` makes `dragging._draggable`
 * once, and `Draggable._onMove` reads `options.clickTolerance` on each move.
 * The capture `pointerdown` runs before Leaflet's own down handler.
 * Returns a function that removes the listener.
 */
export function setPressTolerance(map: PressMap): () => void {
  const el = map.getContainer();
  const down = (e: PointerEvent) => {
    const options = map.dragging?._draggable?.options;
    if (!options) return;
    const press = e.pointerType === "pen" || e.pointerType === "touch";
    options.clickTolerance = press ? PRESS_SLOP_PX : MOUSE_CLICK_TOLERANCE;
  };
  const opts = { capture: true, passive: true };
  el.addEventListener("pointerdown", down, opts);
  return () => el.removeEventListener("pointerdown", down, opts);
}
