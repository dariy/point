/**
 * MapPage — Leaflet map showing tag locations.
 *
 * Country-type tags are rendered as GeoJSON polygon fills.
 * City / other tags are rendered as proportional circle div-icons.
 *
 * Data source: GET /api/pages/map
 * GeoJSON:     /assets/vendor/leaflet/countries.geojson
 */

import { Component } from "../../components/Component.js";
import { PublicHeader } from "../../components/public/PublicHeader.js";
import { PublicFooter } from "../../components/public/PublicFooter.js";
import { Timeline } from "../../components/public/Timeline.js";
import { getMapPage } from "../../api/pages.js";
import { store } from "../../store.js";
import { escapeHtml } from "../../utils/helpers.js";
import { LOCK_SVG } from "../../utils/icons.js";

const LEAFLET_JS = "/assets/vendor/leaflet/leaflet.js";
const LEAFLET_CSS = "/assets/vendor/leaflet/leaflet.css";
const COUNTRIES_GEOJSON = "/assets/vendor/leaflet/countries.geojson";

const TILE_LIGHT =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_DARK =
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

/** Load Leaflet once; return the L global. */
async function loadLeaflet() {
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

/** Marker radius in px, scaled by post count. */
function markerRadius(postCount) {
  return Math.min(30, Math.max(12, 10 + Math.sqrt(postCount || 1) * 2));
}

/** Stable color based on name (HSL) */
function getCountryColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 65%, 45%)`;
}

export default class MapPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, tags: [], error: null };
    this._map = null;
    this._tileLayer = null;
    this._themeListener = null;
    this._markerLayer = null;
    this._allTagsCount = 0;
    this._currentRange = null;
    this._headerChild = null;
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper site-wrapper--map">
          <div id="header-mount"></div>
          <div id="timeline-mount"></div>
          <main class="site-main site-main--map" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading map…"></div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    if (error) {
      return `
        <div class="site-wrapper site-wrapper--map">
          <div id="header-mount"></div>
          <div id="timeline-mount"></div>
          <main class="site-main site-main--map">
            <p class="error-message" role="alert">${escapeHtml(error)}</p>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    return `
      <div class="site-wrapper site-wrapper--map">
        <div id="header-mount"></div>
        <div id="timeline-mount"></div>
        <main class="site-main site-main--map">
          <div class="map-container"><div id="map"></div></div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    document.body.classList.remove("immersive-layout", "ui-hidden");

    const yearParam = this.props.params?.year;
    let initialRange = null;
    if (yearParam) {
      const parts = yearParam.split('-');
      if (parts.length === 2) {
        const from = parseInt(parts[0], 10);
        const to = parseInt(parts[1], 10);
        if (!isNaN(from) && !isNaN(to)) {
          initialRange = { from, to };
          this._currentRange = { from, to };
        }
      } else {
        const year = parseInt(yearParam, 10);
        if (!isNaN(year)) {
          initialRange = { from: year, to: year };
          this._currentRange = { from: year, to: year };
        }
      }
    }

    const settings = store.get("settings") || {};
    this._headerChild = this.mountChild(PublicHeader, "#header-mount", {
      settings,
      currentPath: "/map",
      breadcrumb: this._buildBreadcrumb(),
    });
    this.mountChild(PublicFooter, "#footer-mount", { settings });

    const canShowTimeline =
      settings.timeline_mode === "all" ||
      (store.get("user") && settings.timeline_mode === "hidden");
    if (canShowTimeline) {
      this.mountChild(Timeline, "#timeline-mount", {
        mode: "filter",
        initialRange,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
      });
    }

    if (this.state.loading) {
      this._loadData();
    } else {
      this._initMap();
    }
  }

  async _loadData() {
    try {
      const { tags } = await getMapPage();
      this._allTagsCount = tags.length;
      this.setState({ loading: false, tags });
    } catch (err) {
      this.setState({
        loading: false,
        tags: [],
        error: err.message || "Failed to load map data.",
      });
    }
  }

  _buildBreadcrumb() {
    if (!this._currentRange) {
      return [{ name: 'map' }];
    }
    const { from, to } = this._currentRange;
    const label = from === to ? String(from) : `${from}–${to}`;
    return [{ name: 'map', href: '/map' }, { name: label }];
  }

  async _onTimelineRangeChange({ from, to }) {
    const hasRange = from !== undefined && to !== undefined;
    this._currentRange = hasRange ? { from, to } : null;
    this._headerChild?.setProps({ breadcrumb: this._buildBreadcrumb() });

    if (hasRange) {
      const rangeStr = from === to ? String(from) : `${from}-${to}`;
      history.replaceState(null, '', `/map/${rangeStr}`);
    }
    const params = hasRange ? { year_from: from, year_to: to } : {};
    try {
      const { tags } = await getMapPage(params);
      this.state.tags = tags;
      this._redrawMarkers();
      this._updateStats();
    } catch (err) {
      console.error("Failed to filter map:", err);
    }
  }

  _updateStats() {
    const statsEl = this.$("#map-stats");
    if (!statsEl) return;
    const count = this.state.tags.length;
    const total = this._allTagsCount || count;
    statsEl.textContent = `Showing ${count} of ${total} locations`;
  }

  async _initMap() {
    const mapEl = this.$("#map");
    if (!mapEl) return;

    let L;
    try {
      L = await loadLeaflet();
    } catch {
      mapEl.textContent = "Failed to load map library.";
      return;
    }

    const isDark =
      document.documentElement.dataset.theme === "dark" ||
      (document.documentElement.dataset.theme === "auto" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);

    // Initialize map with bounds and wrapping disabled
    this._map = L.map(mapEl, {
      minZoom: 2,
      maxBounds: [
        [-90, -180],
        [90, 180],
      ],
      maxBoundsViscosity: 1.0,
    }).setView([20, 0], 2);

    this._tileLayer = L.tileLayer(isDark ? TILE_DARK : TILE_LIGHT, {
      attribution: TILE_ATTR,
      maxZoom: 18,
      noWrap: true,
      bounds: [
        [-90, -180],
        [90, 180],
      ],
    }).addTo(this._map);

    this._markerLayer = L.layerGroup().addTo(this._map);

    // Listen for theme toggle and swap tile layer
    this._themeListener = () => {
      const dark =
        document.documentElement.dataset.theme === "dark" ||
        (document.documentElement.dataset.theme === "auto" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      if (this._tileLayer && this._map) {
        this._tileLayer.setUrl(dark ? TILE_DARK : TILE_LIGHT);
      }
    };
    document.addEventListener("themechange", this._themeListener);

    this._redrawMarkers();
    this._updateStats();
  }

  async _redrawMarkers() {
    if (!this._map || !this._markerLayer) return;
    const L = window.L;
    this._markerLayer.clearLayers();

    const { tags } = this.state;

    // Build lookup: lowercased tag name → tag (for country polygon matching)
    const countryTagMap = {};
    tags.forEach((t) => {
      if (t.type === "country" || t.type === "city") {
        countryTagMap[t.name.toLowerCase()] = t;
      }
    });

    // Load GeoJSON if not cached
    if (!this._geojson) {
      try {
        const resp = await fetch(COUNTRIES_GEOJSON);
        this._geojson = await resp.json();
      } catch {
        // GeoJSON load failure is non-fatal
      }
    }

    if (this._geojson) {
      L.geoJSON(this._geojson, {
        style: (feature) => {
          const rawName = feature.properties?.name || "";
          const name = rawName.toLowerCase();
          const tag = countryTagMap[name];
          const highlighted = !!tag;
          const countryColor = getCountryColor(rawName);

          return {
            color: highlighted ? "#e05c00" : "#888",
            weight: highlighted ? 1.5 : 0.5,
            fillColor: countryColor,
            fillOpacity: highlighted ? 0.35 : 0.1,
            opacity: highlighted ? 0.8 : 0.3,
          };
        },
        onEachFeature: (feature, layer) => {
          const name = (feature.properties?.name || "").toLowerCase();
          const tag = countryTagMap[name];
          if (!tag) return;

          const yearsHtml =
            tag.years && tag.years.length > 0
              ? `<div class="map-popup-years">` +
                tag.years
                  .map(
                    (y) =>
                      `<a href="/tag/${encodeURIComponent(y.slug)}" class="map-year-link">${escapeHtml(y.name)}</a>`,
                  )
                  .join(" ") +
                `</div>`
              : "";
          const lockIcon = tag.is_hidden ? LOCK_SVG : "";
          layer.bindPopup(
            `<a href="/tag/${encodeURIComponent(tag.slug)}" class="map-popup-tag${tag.is_hidden ? " is-hidden" : ""}">${lockIcon}${escapeHtml(tag.name)}</a>` +
              `<div class="tag-popup-count">${tag.post_count} post${tag.post_count !== 1 ? "s" : ""}</div>` +
              yearsHtml,
          );
          layer.on("click", (e) => layer.openPopup(e.latlng));
        },
      }).addTo(this._markerLayer);
    }

    // Render circle markers for city / other tags (not countries)
    const bounds = [];
    tags.forEach((tag) => {
      if (tag.type === "country") return;
      const r = markerRadius(tag.post_count);
      const markerHtml = `<span style="
            display:block;
            width:${r}px;height:${r}px;
            border-radius:50%;
            background:rgba(224,92,0,0.75);
            border:2px solid rgba(224,92,0,1);
            box-shadow:0 1px 4px rgba(0,0,0,0.3);
          "></span>`;
      const icon = L.divIcon({
        className: "",
        html: markerHtml,
        iconSize: [r, r],
        iconAnchor: [r / 2, r / 2],
      });

      const marker = L.marker([tag.lat, tag.lng], { icon }).addTo(
        this._markerLayer,
      );

      const yearsHtml =
        tag.years && tag.years.length > 0
          ? `<div class="map-popup-years">` +
            tag.years
              .map(
                (y) =>
                  `<a href="/tag/${encodeURIComponent(y.slug)}" class="map-year-link">${escapeHtml(y.name)}</a>`,
              )
              .join(" ") +
            `</div>`
          : "";
      const lockIcon = tag.is_hidden ? LOCK_SVG : "";
      marker.bindPopup(
        `<a href="/tag/${encodeURIComponent(tag.slug)}" class="map-popup-tag${tag.is_hidden ? " is-hidden" : ""}">${lockIcon}${escapeHtml(tag.name)}</a>` +
          `<div class="tag-popup-count">${tag.post_count} post${tag.post_count !== 1 ? "s" : ""}</div>` +
          yearsHtml,
      );
      marker.on("click", () => marker.openPopup());
      bounds.push([tag.lat, tag.lng]);
    });

    if (bounds.length && !this._currentRange) {
      this._map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
    }
  }

  beforeUnmount() {
    if (this._themeListener) {
      document.removeEventListener("themechange", this._themeListener);
    }
    this._map?.remove();
  }
}
