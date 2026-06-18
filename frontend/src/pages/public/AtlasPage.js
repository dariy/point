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
    this._activeAnchor = null; // latlng the current cloud is built around
    this._activeSetActive = null; // toggles the current selection's highlight
    this._activeKey = null;
    this._cloud = null; // { anchorLatLng, nodePos, sats, edges }
    this._baseDimmables = []; // base-map places: { tagId, setDim } for focus dimming
    this._hiddenTypes = new Set(); // node types filtered out via the legend
    this._reposition = () => this._repositionCloud();

    // Indexes derived from the graph payload (built once on load).
    this._tagsById = new Map();
    this._postsById = new Map();
    this._postsByTag = new Map(); // tagId -> Set(postId)
    this._tagsByPost = new Map(); // postId -> Set(tagId)
    this._childrenByTag = new Map(); // tagId -> [childTagId] (hierarchy)
    this._membershipEdges = [];
    this._hierarchyEdges = [];
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
            <div class="atlas-legend" role="group" aria-label="Filter node types">
              <span class="atlas-legend__row atlas-legend__row--static"><span class="atlas-legend__dot atlas-legend__dot--geo"></span>Place</span>
              <button type="button" class="atlas-toggle" data-type="tag" aria-pressed="true"><span class="atlas-legend__dot atlas-legend__dot--tag"></span>Tag</button>
              <button type="button" class="atlas-toggle" data-type="year" aria-pressed="true"><span class="atlas-legend__dot atlas-legend__dot--year"></span>Year</button>
              <button type="button" class="atlas-toggle" data-type="post" aria-pressed="true"><span class="atlas-legend__dot atlas-legend__dot--post"></span>Post</button>
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

    this._wireToggles();
    this._initMap();
  }

  /** Legend toggles hide/show a node type (tag/year/post) like the /tags page. */
  _wireToggles() {
    this.container.querySelectorAll(".atlas-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.type;
        const turnOff = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", String(!turnOff));
        btn.classList.toggle("is-off", turnOff);
        if (turnOff) this._hiddenTypes.add(type);
        else this._hiddenTypes.delete(type);
        this._refreshCloud();
      });
    });
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

    this._hierarchyEdges = data.hierarchyEdges || [];
    this._hierarchyEdges.forEach((e) => {
      if (!this._childrenByTag.has(e.parent))
        this._childrenByTag.set(e.parent, []);
      this._childrenByTag.get(e.parent).push(e.child);
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

    // zoomAnimation is disabled deliberately: with it on, Leaflet 1.9.4 animates
    // the country GeoJSON (SVG overlay) with a transform that doesn't track the
    // tile pane for this map's geometry, so the shapes visibly drift mid-zoom and
    // only snap back on zoomend. Snapping the zoom keeps the overlay locked to the
    // map. (The canvas renderer shares the same drift, so it's not an alternative.)
    this._map = L.map(mapEl, {
      minZoom: 2,
      maxBounds: [
        [-90, -180],
        [90, 180],
      ],
      maxBoundsViscosity: 1.0,
      zoomAnimation: false,
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

          const setDim = (on) =>
            layer.setStyle(
              on ? { opacity: 0.12, fillOpacity: 0.03 } : baseStyle(feature),
            );
          this._baseDimmables.push({ tagId: tag.id, setDim });

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

      const setDim = (on) =>
        marker._icon?.classList.toggle("atlas-marker--dim", on);
      this._baseDimmables.push({ tagId: tag.id, setDim });

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
   * stable id identifying the place.
   *
   * Clicking a place follows the same two-click model as the cloud chips (and
   * the /tags graph): the first click reveals the place's connections (its
   * cloud, everything lit). If a chip is currently focused, the next click on
   * the place collapses back to that overview; once the place itself is the
   * selection, a further click opens its tag page. Empty-map clicks dismiss.
   */
  _select(tag, anchorLatLng, setActive, key) {
    if (this._activeKey === key) {
      if (this._cloud && this._cloud.focusKey !== null) {
        this._cloud.focusKey = null;
        this._applyCloudFocus();
      } else {
        navigate(`/tags/${tag.slug}`);
      }
      return;
    }
    this._clearCloud();
    this._activeSetActive?.(false);

    // Dim every place not connected to this selection, so the selected place and
    // the places it shares posts with stand out (mirrors the /tags graph). Done
    // before setActive so the active place keeps its own highlight on top.
    this._applyBaseDim(this._buildSubgraph(tag).tagIds);

    setActive(true);
    this._activeSetActive = setActive;
    this._activeKey = key;
    this._activeTag = tag;
    this._activeAnchor = anchorLatLng;

    this.$("#atlas-hint")?.classList.add("is-hidden");

    this._spawnCloud(tag, anchorLatLng);

    // Nudge the place into view if its cloud would spill off an edge.
    if (typeof this._map.panInside === "function") {
      this._map.panInside(anchorLatLng, { padding: [220, 220] });
    }
  }

  /**
   * Dim every base-map place whose tag isn't in `connectedTagIds`; pass null to
   * restore them all. The selected place and the places it shares posts with stay
   * at full strength, focusing the map on the active selection like /tags does.
   */
  _applyBaseDim(connectedTagIds) {
    for (const d of this._baseDimmables) {
      d.setDim(connectedTagIds ? !connectedTagIds.has(d.tagId) : false);
    }
  }

  /** Rebuild the active cloud in place (e.g. after a legend filter change). */
  _refreshCloud() {
    if (!this._activeTag || !this._activeAnchor) return;
    this._clearCloud();
    this._spawnCloud(this._activeTag, this._activeAnchor);
  }

  /**
   * Slice the full graph down to one place and its whole sub-tree. Starting
   * from the clicked tag we walk the hierarchy down (a country → its cities →
   * any sub-places), gather every post tagged by any of them, then the co-tags
   * those posts also carry. Returns the place-tag id set, post id set and the
   * full included-tag id set so connections can be drawn between them.
   */
  _buildSubgraph(rootTag) {
    const placeTagIds = new Set([rootTag.id]);
    const queue = [rootTag.id];
    while (queue.length) {
      const cur = queue.shift();
      (this._childrenByTag.get(cur) || []).forEach((c) => {
        if (!placeTagIds.has(c)) {
          placeTagIds.add(c);
          queue.push(c);
        }
      });
    }

    const postIds = new Set();
    placeTagIds.forEach((tid) => {
      (this._postsByTag.get(tid) || []).forEach((p) => postIds.add(p));
    });

    const tagIds = new Set(placeTagIds);
    postIds.forEach((pid) => {
      (this._tagsByPost.get(pid) || []).forEach((t) => tagIds.add(t));
    });

    return { placeTagIds, postIds, tagIds };
  }

  /** Node-type bucket used for colouring + the legend filters. */
  _kindOf(tag) {
    if (tag.kind === "year") return "year";
    if (typeof tag.latitude === "number" && typeof tag.longitude === "number")
      return "geo";
    return "tag"; // plain tags + topics (matches the /tags graph)
  }

  /**
   * Build the on-map cloud: chips for the place's sub-tags, co-tags and posts,
   * wired together with their real hierarchy + membership edges. The clicked
   * tag sits at the centre (the marker / polygon itself); everything else fans
   * out on rings around it. Legend-hidden node types are dropped.
   */
  _spawnCloud(tag, anchorLatLng) {
    const L = window.L;
    const { postIds, tagIds } = this._buildSubgraph(tag);
    const hidden = this._hiddenTypes;
    const centerKey = "t" + tag.id;

    // Satellite tag chips (everything except the centre). Place chips have no
    // toggle — they're the structural backbone, always shown.
    const tagSats = [];
    tagIds.forEach((id) => {
      if (id === tag.id) return;
      const t = this._tagsById.get(id);
      if (!t) return;
      const kind = this._kindOf(t);
      if (hidden.has(kind)) return;
      tagSats.push({
        key: "t" + id,
        kind,
        label: t.name,
        href: `/tags/${t.slug}`,
        max: 26,
      });
    });

    const postSats = [];
    if (!hidden.has("post")) {
      postIds.forEach((id) => {
        const p = this._postsById.get(id);
        if (!p) return;
        postSats.push({
          key: "p" + id,
          kind: "post",
          label: p.title || p.slug,
          href: `/posts/${p.slug}`,
          max: 24,
        });
      });
    }

    // Order: places (inner, next to the centre) → other tags → posts (outer).
    const places = tagSats.filter((n) => n.kind === "geo");
    const otherTags = tagSats.filter((n) => n.kind !== "geo");
    const ordered = [...places, ...otherTags, ...postSats];

    const nodePos = new Map([[centerKey, { dx: 0, dy: 0 }]]);
    const placed = ringLayout(ordered.length || 1);
    ordered.forEach((n, i) => nodePos.set(n.key, placed[i]));

    const anchorPt = this._map.latLngToContainerPoint(anchorLatLng);
    const llOf = (pos) =>
      this._map.containerPointToLatLng(anchorPt.add([pos.dx, pos.dy]));

    // Edges first so they render beneath the chips. We also record adjacency so
    // a chip click can light up its connections (see _expandCloudFocus).
    const edges = [];
    const cloudNeighbors = new Map();
    const link = (a, b) => {
      if (!cloudNeighbors.has(a)) cloudNeighbors.set(a, new Set());
      cloudNeighbors.get(a).add(b);
    };
    const addEdge = (a, b, kind) => {
      if (!nodePos.has(a) || !nodePos.has(b)) return;
      link(a, b);
      link(b, a);
      const baseOpacity = kind === "hier" ? 0.65 : 0.45;
      const style =
        kind === "hier"
          ? { color: "#1f9e8e", weight: 1.8, opacity: baseOpacity }
          : { color: "#8a93a6", weight: 1.1, opacity: baseOpacity, dashArray: "3 4" };
      const line = L.polyline([llOf(nodePos.get(a)), llOf(nodePos.get(b))], {
        ...style,
        className: "atlas-link",
        interactive: false,
      });
      this._cloudLines.addLayer(line);
      edges.push({ a, b, line, baseOpacity });
    };
    this._hierarchyEdges.forEach((e) =>
      addEdge("t" + e.parent, "t" + e.child, "hier"),
    );
    this._membershipEdges.forEach((e) =>
      addEdge("p" + e.post, "t" + e.tag, "memb"),
    );

    const sats = ordered.map((node, i) => {
      const ll = llOf(nodePos.get(node.key));
      const icon = L.divIcon({
        className: "atlas-node-wrap",
        html: `<span class="atlas-node atlas-node--${node.kind}" style="animation-delay:${i * 16}ms" title="${escapeHtml(node.label)}">${escapeHtml(truncate(node.label, node.max))}</span>`,
        iconSize: [0, 0],
      });
      const marker = L.marker(ll, { icon, keyboard: false, riseOnHover: true });
      marker.on("click", (e) => {
        L.DomEvent.stop(e);
        this._focusCloudNode(node.key, node.href);
      });
      this._cloudMarkers.addLayer(marker);
      return { key: node.key, marker };
    });

    this._cloud = {
      anchorLatLng,
      nodePos,
      sats,
      edges,
      cloudNeighbors,
      focusKey: null,
    };
  }

  /**
   * Chip click — two-click model matching the /tags graph: the first click on a
   * chip highlights its connections (dimming the rest), a second click on the
   * same chip opens it. Clicking a different chip moves the highlight.
   */
  _focusCloudNode(key, href) {
    if (!this._cloud) return;
    if (this._cloud.focusKey === key) {
      navigate(href);
      return;
    }
    this._cloud.focusKey = key;
    this._applyCloudFocus();
  }

  /**
   * The highlighted set for a focused chip. A post lights its direct tags; a tag
   * lights its neighbours and then a second hop through each adjacent post to the
   * other tags sharing it (those get a distinct dashed ring) — the same "two
   * joints through a shared post" reveal the /tags graph uses.
   */
  _expandCloudFocus(seedKey) {
    const nb = this._cloud.cloudNeighbors;
    const focus = new Set([seedKey]);
    const related = new Set();
    const seedIsTag = seedKey[0] === "t";
    const neighbors = nb.get(seedKey);
    if (neighbors) {
      for (const n of neighbors) {
        focus.add(n);
        if (!seedIsTag || n[0] !== "p") continue;
        const postNbrs = nb.get(n);
        if (!postNbrs) continue;
        for (const t of postNbrs) {
          if (t === seedKey) continue;
          focus.add(t);
          related.add(t);
        }
      }
    }
    return { focus, related };
  }

  /** Apply the current cloud focus (or clear it) to chip + connector styling. */
  _applyCloudFocus() {
    if (!this._cloud) return;
    const { sats, edges, focusKey } = this._cloud;
    const data = focusKey ? this._expandCloudFocus(focusKey) : null;
    const focus = data && data.focus;
    const related = data && data.related;

    for (const s of sats) {
      const el = s.marker._icon?.firstElementChild;
      if (!el) continue;
      const inFocus = !focus || focus.has(s.key);
      el.classList.toggle("atlas-node--dim", !inFocus);
      el.classList.toggle("atlas-node--sel", focusKey === s.key);
      el.classList.toggle(
        "atlas-node--related",
        !!(related && related.has(s.key) && focusKey !== s.key),
      );
    }
    for (const e of edges) {
      const lit = !focus || (focus.has(e.a) && focus.has(e.b));
      e.line.setStyle({ opacity: lit ? e.baseOpacity : e.baseOpacity * 0.12 });
    }
  }

  _repositionCloud() {
    if (!this._cloud || !this._map) return;
    const { anchorLatLng, nodePos, sats, edges } = this._cloud;
    const anchorPt = this._map.latLngToContainerPoint(anchorLatLng);
    // Pass the offset as an [x, y] array — Leaflet's Point.add() doesn't
    // understand a {dx, dy} object and would yield NaN coordinates, flinging
    // the whole cloud across the map on the first zoom.
    const llOf = (key) => {
      const pos = nodePos.get(key);
      return this._map.containerPointToLatLng(anchorPt.add([pos.dx, pos.dy]));
    };
    sats.forEach((s) => s.marker.setLatLng(llOf(s.key)));
    edges.forEach((e) => e.line.setLatLngs([llOf(e.a), llOf(e.b)]));
  }

  _clearCloud() {
    this._cloudMarkers?.clearLayers();
    this._cloudLines?.clearLayers();
    this._cloud = null;
  }

  _clearSelection() {
    this._clearCloud();
    this._applyBaseDim(null);
    this._activeSetActive?.(false);
    this._activeSetActive = null;
    this._activeKey = null;
    this._activeTag = null;
    this._activeAnchor = null;
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
