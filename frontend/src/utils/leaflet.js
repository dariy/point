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

/** Load Leaflet once; return the L global. */
export async function loadLeaflet() {
  if (window.L) return window.L;

  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);
  }

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  return window.L;
}
