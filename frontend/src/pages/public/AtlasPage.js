/**
 * AtlasPage — experimental "tags on the map" view.
 *
 * A single Leaflet map plots every geo-tag (a tag carrying lat/long, e.g. from
 * EXIF GPS) as a marker. Clicking a place reveals everything it touches — its
 * posts and the tags / year-tags those posts also carry — as a cloud of chips
 * that fan out *on the map*, anchored to that location and wired back to it.
 * Pan and zoom keep the cloud pinned to its place; clicking a chip opens it.
 *
 * One data source feeds it all: GET /api/pages/graph already returns geo
 * coordinates alongside the full tag/post/edge graph.
 *
 * Props (from router): { params, query }
 */

import { Component } from "../../components/Component.js";
import { PublicHeader } from "../../components/public/PublicHeader.js";
import { PublicFooter } from "../../components/public/PublicFooter.js";
import { getTagsGraph } from "../../api/pages.js";
import { store } from "../../store.js";
import {
  escapeHtml,
  navigate,
  setCanonical,
  removeCanonical,
} from "../../utils/helpers.js";

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

/** Marker radius in px for a geo-tag, scaled by post count. */
function markerRadius(postCount) {
  return Math.min(30, Math.max(12, 10 + Math.sqrt(postCount || 1) * 2));
}

/** Stable fill colour for a country shape, derived from its name (HSL). */
function getCountryColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash % 360)}, 60%, 48%)`;
}

function isDarkTheme() {
  const t = document.documentElement.dataset.theme;
  return (
    t === "dark" ||
    (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
}

function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Place `count` chips on concentric rings around the origin (pixel space).
 * Inner rings fill first; arc spacing keeps pills from colliding.
 */
function ringLayout(count, { startR = 66, ringGap = 46, minArc = 92 } = {}) {
  const out = [];
  let i = 0;
  let ring = 0;
  while (i < count) {
    const radius = startR + ring * ringGap;
    const cap = Math.max(1, Math.floor((2 * Math.PI * radius) / minArc));
    const n = Math.min(cap, count - i);
    const offset = (ring % 2) * 0.5; // stagger alternate rings
    for (let k = 0; k < n; k++) {
      const ang = ((k + offset) / n) * Math.PI * 2 - Math.PI / 2;
      out.push({ dx: Math.cos(ang) * radius, dy: Math.sin(ang) * radius });
    }
    i += n;
    ring++;
  }
  return out;
}

export default class AtlasPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, error: null };

    this._map = null;
    this._tileLayer = null;
    this._countryLayer = null; // country GeoJSON polygons
    this._markerLayer = null; // geo-tag markers
    this._cloudMarkers = null; // satellite chips
    this._cloudLines = null; // connector lines
    this._themeListener = null;
    this._geojson = null; // cached countries.geojson
    this._activeTag = null;
    this._activeSetActive = null; // toggles the current selection's highlight
    this._activeKey = null;
    this._cloud = null; // { anchorLatLng, sats: [{dx,dy,marker,line}] }
    this._reposition = () => this._repositionCloud();

    // Indexes derived from the graph payload (built once on load).
    this._tagsById = new Map();
    this._postsById = new Map();
    this._postsByTag = new Map(); // tagId -> Set(postId)
    this._tagsByPost = new Map(); // postId -> Set(tagId)
    this._membershipEdges = [];
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper site-wrapper--atlas">
          <div id="header-mount"></div>
          <main class="site-main site-main--atlas" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading atlas…"></div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    if (error) {
      return `
        <div class="site-wrapper site-wrapper--atlas">
          <div id="header-mount"></div>
          <main class="site-main site-main--atlas">
            <div class="main-container">
              <p class="error-message" role="alert">${escapeHtml(error)}</p>
            </div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    return `
      <div class="site-wrapper site-wrapper--atlas">
        <div id="header-mount"></div>
        <main class="site-main site-main--atlas">
          <div class="atlas-map">
            <div id="atlas-map-el"></div>
            <div class="atlas-hint" id="atlas-hint">Click a place to reveal its tags &amp; posts</div>
            <div class="atlas-legend" aria-hidden="true">
              <span class="atlas-legend__row"><span class="atlas-legend__dot atlas-legend__dot--geo"></span>Place</span>
              <span class="atlas-legend__row"><span class="atlas-legend__dot atlas-legend__dot--tag"></span>Tag</span>
              <span class="atlas-legend__row"><span class="atlas-legend__dot atlas-legend__dot--year"></span>Year</span>
              <span class="atlas-legend__row"><span class="atlas-legend__dot atlas-legend__dot--post"></span>Post</span>
            </div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    document.body.classList.remove("immersive-layout", "ui-hidden");

    const settings = store.get("settings") || {};
    this.mountChild(PublicHeader, "#header-mount", {
      settings,
      currentPath: "/atlas",
    });
    this.mountChild(PublicFooter, "#footer-mount", { settings });

    if (this.state.loading) {
      this._load();
      return;
    }
    if (this.state.error || !this.state.data) return;

    this._initMap();
  }

  async _load() {
    try {
      const data = await getTagsGraph();
      document.title = "Atlas";
      setCanonical(`${window.location.origin}/atlas`);
      this._buildIndexes(data);
      this.setState({ loading: false, data, error: null });
    } catch (err) {
      this.setState({
        loading: false,
        data: null,
        error: err.message || "Failed to load atlas.",
      });
    }
  }

  /** Build the lookup tables the sub-graph slicing needs. */
  _buildIndexes(data) {
    (data.tags || []).forEach((t) => this._tagsById.set(t.id, t));
    (data.posts || []).forEach((p) => this._postsById.set(p.id, p));

    this._membershipEdges = data.membershipEdges || [];
    this._membershipEdges.forEach((e) => {
      if (!this._postsByTag.has(e.tag)) this._postsByTag.set(e.tag, new Set());
      this._postsByTag.get(e.tag).add(e.post);
      if (!this._tagsByPost.has(e.post)) this._tagsByPost.set(e.post, new Set());
      this._tagsByPost.get(e.post).add(e.tag);
    });
  }

  // ── Map ────────────────────────────────────────────────────────────────────

  async _initMap() {
    const mapEl = this.$("#atlas-map-el");
    if (!mapEl) return;

    let L;
    try {
      L = await loadLeaflet();
    } catch {
      mapEl.textContent = "Failed to load map library.";
      return;
    }
    if (this._unmounted) return;

    this._map = L.map(mapEl, {
      minZoom: 2,
      maxBounds: [
        [-90, -180],
        [90, 180],
      ],
      maxBoundsViscosity: 1.0,
    }).setView([20, 0], 2);

    this._tileLayer = L.tileLayer(isDarkTheme() ? TILE_DARK : TILE_LIGHT, {
      attribution: TILE_ATTR,
      maxZoom: 18,
      noWrap: true,
      bounds: [
        [-90, -180],
        [90, 180],
      ],
    }).addTo(this._map);

    this._countryLayer = L.layerGroup().addTo(this._map); // polygons (lowest)
    this._cloudLines = L.layerGroup().addTo(this._map); // connectors, below markers
    this._markerLayer = L.layerGroup().addTo(this._map);
    this._cloudMarkers = L.layerGroup().addTo(this._map);

    this._themeListener = () => {
      if (this._tileLayer) {
        this._tileLayer.setUrl(isDarkTheme() ? TILE_DARK : TILE_LIGHT);
      }
    };
    document.addEventListener("themechange", this._themeListener);

    // Keep the cloud pinned to its place as the zoom level changes.
    this._map.on("zoomend viewreset", this._reposition);
    // Clicking empty map dismisses the current cloud.
    this._map.on("click", () => this._clearSelection());

    await this._drawLayers(L);
  }

  /**
   * Render country tags as GeoJSON polygon shapes (mirroring /map) and the
   * remaining geo-tags as proportional circle markers. A geo-tag counts as a
   * "country shape" when its name matches a feature in countries.geojson.
   */
  async _drawLayers(L) {
    const geoTags = (this.state.data.tags || []).filter(
      (t) => typeof t.latitude === "number" && typeof t.longitude === "number",
    );

    // name (lowercased) → geo-tag, for matching against GeoJSON features.
    const geoTagByName = {};
    geoTags.forEach((t) => {
      geoTagByName[t.name.toLowerCase()] = t;
    });

    if (!this._geojson) {
      try {
        const resp = await fetch(COUNTRIES_GEOJSON);
        this._geojson = await resp.json();
      } catch {
        this._geojson = null; // non-fatal: fall back to circle markers only
      }
    }
    if (this._unmounted || !this._map) return;

    const shapeTagIds = new Set();
    const bounds = [];

    if (this._geojson) {
      const baseStyle = (feature) => {
        const rawName = feature.properties?.name || "";
        const tag = geoTagByName[rawName.toLowerCase()];
        const fill = getCountryColor(rawName);
        return tag
          ? {
              color: "#e05c00",
              weight: 1.5,
              opacity: 0.85,
              fillColor: fill,
              fillOpacity: 0.4,
            }
          : {
              color: "#888",
              weight: 0.5,
              opacity: 0.3,
              fillColor: fill,
              fillOpacity: 0.08,
            };
      };

      L.geoJSON(this._geojson, {
        style: baseStyle,
        onEachFeature: (feature, layer) => {
          const rawName = feature.properties?.name || "";
          const tag = geoTagByName[rawName.toLowerCase()];
          if (!tag) return;
          shapeTagIds.add(tag.id);
          bounds.push([tag.latitude, tag.longitude]);

          const setActive = (on) =>
            layer.setStyle(
              on
                ? { weight: 2.5, fillOpacity: 0.6, opacity: 1 }
                : baseStyle(feature),
            );

          layer.on("click", (e) => {
            L.DomEvent.stop(e);
            this._select(
              tag,
              layer.getBounds().getCenter(),
              setActive,
              "c" + tag.id,
            );
          });
        },
      }).addTo(this._countryLayer);
    }

    // Circle markers for every geo-tag that isn't drawn as a country shape.
    geoTags.forEach((tag) => {
      if (shapeTagIds.has(tag.id)) return;
      const r = markerRadius(tag.post_count);
      const icon = L.divIcon({
        className: "atlas-marker",
        html: `<span class="atlas-marker__dot" style="width:${r}px;height:${r}px;"></span>`,
        iconSize: [r, r],
        iconAnchor: [r / 2, r / 2],
      });
      const marker = L.marker([tag.latitude, tag.longitude], {
        icon,
        title: tag.name,
      }).addTo(this._markerLayer);

      const setActive = (on) =>
        marker._icon?.classList.toggle("atlas-marker--active", on);

      marker.on("click", (e) => {
        L.DomEvent.stop(e); // don't let the map's click handler clear it
        this._select(tag, marker.getLatLng(), setActive, "m" + tag.id);
      });
      bounds.push([tag.latitude, tag.longitude]);
    });

    if (bounds.length) {
      this._map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
    }
  }

  // ── Selection → on-map cloud ────────────────────────────────────────────────

  /**
   * Activate a place: highlight it, spawn its cloud. `setActive(bool)` toggles
   * the source's own highlight (marker class or polygon style); `key` is a
   * stable id so clicking the active place again dismisses it.
   */
  _select(tag, anchorLatLng, setActive, key) {
    if (this._activeKey === key) {
      this._clearSelection();
      return;
    }
    this._clearCloud();
    this._activeSetActive?.(false);

    setActive(true);
    this._activeSetActive = setActive;
    this._activeKey = key;
    this._activeTag = tag;

    this.$("#atlas-hint")?.classList.add("is-hidden");

    this._spawnCloud(tag, anchorLatLng);

    // Nudge the place into view if its cloud would spill off an edge.
    if (typeof this._map.panInside === "function") {
      this._map.panInside(anchorLatLng, { padding: [220, 220] });
    }
  }

  /** Slice the full graph down to one place: its posts and their co-tags. */
  _buildSubgraph(geoTag) {
    const postIds = this._postsByTag.get(geoTag.id) || new Set();
    const tagIds = new Set();
    postIds.forEach((pid) => {
      (this._tagsByPost.get(pid) || []).forEach((tid) => {
        if (tid !== geoTag.id) tagIds.add(tid);
      });
    });

    const tags = [...tagIds].map((id) => this._tagsById.get(id)).filter(Boolean);
    const posts = [...postIds]
      .map((id) => this._postsById.get(id))
      .filter(Boolean);
    return { tags, posts };
  }

  _kindOf(tag) {
    if (tag.kind === "year") return "year";
    if (typeof tag.latitude === "number" && typeof tag.longitude === "number")
      return "geo";
    if (tag.kind === "topic") return "topic";
    return "tag";
  }

  _spawnCloud(tag, anchorLatLng) {
    const L = window.L;
    const sub = this._buildSubgraph(tag);

    // Co-tags first (inner rings), then posts (outer) — tags read closest to
    // the place, posts further out.
    const items = [
      ...sub.tags.map((t) => ({
        kind: this._kindOf(t),
        label: t.name,
        href: `/tags/${t.slug}`,
        max: 26,
      })),
      ...sub.posts.map((p) => ({
        kind: "post",
        label: p.title || p.slug,
        href: `/posts/${p.slug}`,
        max: 24,
      })),
    ];

    if (!items.length) return;

    const placed = ringLayout(items.length);
    const anchorPt = this._map.latLngToContainerPoint(anchorLatLng);

    const sats = placed.map((pos, i) => {
      const node = items[i];
      const ll = this._map.containerPointToLatLng(anchorPt.add([pos.dx, pos.dy]));

      const icon = L.divIcon({
        className: "atlas-node-wrap",
        html: `<span class="atlas-node atlas-node--${node.kind}" style="animation-delay:${i * 16}ms" title="${escapeHtml(node.label)}">${escapeHtml(truncate(node.label, node.max))}</span>`,
        iconSize: [0, 0],
      });
      const marker = L.marker(ll, { icon, keyboard: false, riseOnHover: true });
      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        navigate(node.href);
      });
      this._cloudMarkers.addLayer(marker);

      const line = L.polyline([anchorLatLng, ll], {
        color: "#8a93a6",
        weight: 1.4,
        opacity: 0.55,
        className: "atlas-link",
        interactive: false,
      });
      this._cloudLines.addLayer(line);

      return { dx: pos.dx, dy: pos.dy, marker, line };
    });

    this._cloud = { anchorLatLng, sats };
  }

  _repositionCloud() {
    if (!this._cloud || !this._map) return;
    const anchorPt = this._map.latLngToContainerPoint(this._cloud.anchorLatLng);
    this._cloud.sats.forEach((s) => {
      const ll = this._map.containerPointToLatLng(anchorPt.add([s.dx, s.dy]));
      s.marker.setLatLng(ll);
      s.line.setLatLngs([this._cloud.anchorLatLng, ll]);
    });
  }

  _clearCloud() {
    this._cloudMarkers?.clearLayers();
    this._cloudLines?.clearLayers();
    this._cloud = null;
  }

  _clearSelection() {
    this._clearCloud();
    this._activeSetActive?.(false);
    this._activeSetActive = null;
    this._activeKey = null;
    this._activeTag = null;
    this.$("#atlas-hint")?.classList.remove("is-hidden");
  }

  beforeUnmount() {
    this._unmounted = true;
    if (this._map) {
      this._map.off("zoomend viewreset", this._reposition);
    }
    if (this._themeListener) {
      document.removeEventListener("themechange", this._themeListener);
      this._themeListener = null;
    }
    this._map?.remove();
    this._map = null;
    removeCanonical();
  }
}
