export const LEAFLET_JS = "/assets/vendor/leaflet/leaflet.js";
export const LEAFLET_CSS = "/assets/vendor/leaflet/leaflet.css";
export const COUNTRIES_GEOJSON = "/assets/vendor/leaflet/countries.geojson";

export const TILE_LIGHT =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
export const TILE_DARK =
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
export const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

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
