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
import { pluginHost } from "../../core/pluginHost.js";
import { getTagsGraph, getTagCloud } from "../../api/pages.js";
import { store } from "../../store.js";
import { ViewContext } from "../../utils/viewContext.js";
import {
  escapeHtml,
  navigate,
  safeUrl,
  setCanonical,
  removeCanonical,
} from "../../utils/helpers.js";
import { tagKind } from "../../utils/tags.js";

import {
  COUNTRIES_GEOJSON,
  TILE_LIGHT,
  TILE_DARK,
  TILE_ATTR,
  loadLeaflet,
} from "../../utils/leaflet.js";

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
    this._cloudData = null; // last-fetched per-place payload backing the open cloud
    this._cloudReq = 0; // monotonic token guarding against out-of-order cloud fetches
    this._cloudCache = new Map(); // "tagId|yearKey" -> fetched cloud payload
    this._placeActivators = new Map(); // tagId -> { latLng, setActive, key } for programmatic selection
    this._hiddenTypes = new Set(); // node types filtered out via the legend
    this._reposition = () => this._repositionCloud();

    this._timeline = null;

    // The only index needed up front: tag id -> tag node (markers + selection).
    // Posts and co-tags are no longer loaded globally — each place fetches its
    // own recent posts + popular tags on tap (see _loadAndSpawnCloud).
    this._tagsById = new Map();
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper site-wrapper--atlas">
          <div id="header-mount"></div>
          <div id="timeline-mount"></div>
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
          <div id="timeline-mount"></div>
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
        <div id="timeline-mount"></div>
        <main class="site-main site-main--atlas">
          <div class="atlas-map">
            <div id="atlas-map-el"></div>
            <div class="atlas-hint" id="atlas-hint">Click a place to reveal its tags &amp; posts</div>
            <div class="atlas-legend" role="group" aria-label="Filter node types">
              <button type="button" class="atlas-toggle" data-type="geo" aria-pressed="true"><span class="atlas-legend__dot atlas-legend__dot--geo"></span>Place</button>
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
    document.body.classList.remove("immersive-layout", "ui-hidden", "immersive-overlay-sheet");

    const settings = store.get("settings") || {};
    this.mountChild(PublicHeader, "#header-mount", {
      settings,
      currentPath: "/tags",
      timelineVisible: true,
    });
    this.mountChild(PublicFooter, "#footer-mount", { settings });

    // Timeline year filter — same visibility gating as /map: shown to everyone
    // in "all" mode, and to signed-in users when it's "hidden" from the public.
    const canShowTimeline = pluginHost.hasSlot("timeline");
    if (canShowTimeline) {
      const vc = ViewContext.current();
      pluginHost.fill("timeline", this.$("#timeline-mount"), {
        mode: "filter",
        initialRange: vc.years ? { from: vc.years[0], to: vc.years[1] } : null,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
      }).then((comps) => {
        if (comps[0] && !this._unmounted) {
          this._timeline = comps[0];
          this._children.push(comps[0]);
        }
      });
    }

    if (this.state.loading) {
      this._load();
      return;
    }
    if (this.state.error || !this.state.data) return;

    this._wireToggles();
    this._initMap();
  }

  /**
   * A timeline-scope change arrives as a same-route navigation (the ?timeline=
   * query param). Re-filter the existing map in place instead of re-rendering —
   * rebuilding would tear down and reflow both the Leaflet map and the timeline.
   */
  onRouteUpdate(params, query) {
    this.props.params = params;
    this.props.query = query;
    if (this._map && !this.state.error) {
      this._applyYearScope();
      const vc = ViewContext.current();
      this._timeline?.setScope(
        vc.years ? { from: vc.years[0], to: vc.years[1] } : null,
      );
    } else {
      this._load();
    }
  }

  /** Timeline emitted a new range — push it to the URL (drives onRouteUpdate). */
  _onTimelineRangeChange({ from, to, isFullExtent }) {
    const years = isFullExtent ? null : [from, to];
    const vc = ViewContext.current();
    const same = years
      ? vc.years && vc.years[0] === years[0] && vc.years[1] === years[1]
      : !vc.years;
    if (same) return;
    ViewContext.update({ years }, { replace: true });
  }

  /**
   * Apply the current timeline year scope. Posts are fetched per-place and
   * year-scoped server-side, so a scope change just re-fetches the open place's
   * cloud (its cache key embeds the year range); with no place selected there is
   * nothing to do.
   */
  _applyYearScope() {
    if (this._activeTag && this._activeAnchor) {
      this._loadAndSpawnCloud(this._activeTag, this._activeAnchor);
    }
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
      // posts=0: the Atlas only needs markers + hierarchy up front; each place's
      // posts are fetched lazily on tap (getTagCloud), so skip the full post set.
      const data = await getTagsGraph({ posts: 0 });
      document.title = "Atlas";
      setCanonical(`${window.location.origin}/tags`);
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

  /** Index the tag (marker) nodes; the graph payload no longer carries posts. */
  _buildIndexes(data) {
    (data.tags || []).forEach((t) => this._tagsById.set(t.id, t));
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
        const props = feature.properties || {};
        const rawName = props.name || "";
        const names = [props.name, props.name_long, props.admin, props.brk_name, props.formal_en]
          .filter(Boolean)
          .map(n => n.toLowerCase());

        let tag = null;
        for (const n of names) {
          if (geoTagByName[n]) {
            tag = geoTagByName[n];
            break;
          }
        }
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
          const props = feature.properties || {};
          const names = [props.name, props.name_long, props.admin, props.brk_name, props.formal_en]
            .filter(Boolean)
            .map(n => n.toLowerCase());

          let tag = null;
          for (const n of names) {
            if (geoTagByName[n]) {
              tag = geoTagByName[n];
              break;
            }
          }
          if (!tag) return;
          shapeTagIds.add(tag.id);
          bounds.push([tag.latitude, tag.longitude]);

          const setActive = (on) =>
            layer.setStyle(
              on
                ? { weight: 2.5, fillOpacity: 0.6, opacity: 1 }
                : baseStyle(feature),
            );

          // Centroid anchor for programmatic reselection (a click uses e.latlng;
          // returning from a post has no click point, so fall back to the tag's
          // own coordinates).
          this._placeActivators.set(tag.id, {
            latLng: L.latLng(tag.latitude, tag.longitude),
            setActive,
            key: "c" + tag.id,
          });

          layer.on("click", (e) => {
            L.DomEvent.stop(e);
            // Anchor the cloud where the user actually clicked: a polygon's
            // bounding-box centre can sit far from the click (or outside the
            // shape entirely) for sprawling or concave countries.
            this._select(tag, e.latlng, setActive, "c" + tag.id);
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

      this._placeActivators.set(tag.id, {
        latLng: marker.getLatLng(),
        setActive,
        key: "m" + tag.id,
      });

      marker.on("click", (e) => {
        L.DomEvent.stop(e); // don't let the map's click handler clear it
        this._select(tag, marker.getLatLng(), setActive, "m" + tag.id);
      });
      bounds.push([tag.latitude, tag.longitude]);
    });

    if (bounds.length) {
      this._map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
    }

    // Honour any year range carried in the URL now that the places exist.
    this._applyYearScope();

    // If we arrived here by closing a post that was opened from the Atlas,
    // reselect its place and highlight the post chip.
    this._restoreFromPost();
  }

  // ── Selection → on-map cloud ────────────────────────────────────────────────

  /**
   * Activate a place: highlight it, spawn its cloud. `setActive(bool)` toggles
   * the source's own highlight (marker class or polygon style); `key` is a
   * stable id identifying the place.
   *
   * The first click reveals the place's connections (its cloud, everything
   * lit). Clicking the place again re-anchors its cloud to the new click point
   * and redraws it as a fresh overview — handy for country shapes, where a
   * second click elsewhere in the shape recentres the cloud there. The place
   * itself never navigates; only its centre title chip opens the tag page
   * (see the centre marker handler in _spawnCloud). Empty-map clicks dismiss.
   */
  _select(tag, anchorLatLng, setActive, key, opts = {}) {
    if (this._activeKey === key) {
      // Re-clicking the active place recentres its already-loaded cloud on the
      // new click point (redraw from the new centre) instead of opening its tag
      // page or re-fetching.
      this._activeAnchor = anchorLatLng;
      if (this._cloudData) {
        this._clearCloud();
        this._spawnCloud(tag, anchorLatLng, this._cloudData);
      }
      if (typeof this._map.panInside === "function") {
        this._map.panInside(anchorLatLng, { padding: [220, 220] });
      }
      return;
    }
    this._clearCloud();
    this._activeSetActive?.(false);

    this._activeKey = key;
    this._activeTag = tag;
    this._activeAnchor = anchorLatLng;

    setActive(true);
    this._activeSetActive = setActive;

    this.$("#atlas-hint")?.classList.add("is-hidden");

    const spawned = this._loadAndSpawnCloud(tag, anchorLatLng, opts);

    // Nudge the place into view if its cloud would spill off an edge.
    if (typeof this._map.panInside === "function") {
      this._map.panInside(anchorLatLng, { padding: [220, 220] });
    }
    return spawned;
  }

  /**
   * Fetch the place's cloud payload (10 recent posts + 10 popular co-tags,
   * year-scoped to the active timeline range) and spawn it. Results are cached
   * per place+year, and a monotonic request token drops the response if the user
   * has since selected a different place. `opts.focusPostSlug` focuses a post
   * chip once the cloud is built (used when returning from an opened post).
   */
  async _loadAndSpawnCloud(tag, anchorLatLng, opts = {}) {
    const vc = ViewContext.current();
    const yearParams = vc.years ? { year_from: vc.years[0], year_to: vc.years[1] } : {};
    const cacheKey = tag.id + "|" + (vc.years ? vc.years.join("-") : "");

    const spawnFrom = (data) => {
      // Ignore a stale response: the user moved on to another place meanwhile.
      if (this._unmounted || this._activeTag !== tag || this._activeKey == null) return;
      this._cloudData = data;
      this._clearCloud();
      this._spawnCloud(tag, anchorLatLng, data);
      if (opts.focusPostSlug) this._focusPostBySlug(opts.focusPostSlug);
    };

    const cached = this._cloudCache.get(cacheKey);
    if (cached) {
      spawnFrom(cached);
      return;
    }

    const token = ++this._cloudReq;
    try {
      const data = await getTagCloud(tag.id, yearParams);
      this._cloudCache.set(cacheKey, data);
      if (token !== this._cloudReq) return; // superseded by a newer selection
      spawnFrom(data);
    } catch {
      if (token === this._cloudReq && this._activeTag === tag) {
        this._clearCloud();
        this._cloudData = null;
      }
    }
  }

  /** Focus a post chip in the open cloud by its slug, if it's among the loaded posts. */
  _focusPostBySlug(slug) {
    if (!this._cloud || !this._cloudData) return;
    const post = (this._cloudData.posts || []).find((p) => p.slug === slug);
    if (!post) return;
    const key = "p" + post.id;
    if (!this._cloud.nodePos.has(key)) return;
    this._cloud.focusKey = key;
    this._applyCloudFocus();
    this._panToCloudNode(key);
  }

  /** Rebuild the active cloud in place (e.g. after a legend filter change). */
  _refreshCloud() {
    if (!this._activeTag || !this._activeAnchor || !this._cloudData) return;
    this._clearCloud();
    this._spawnCloud(this._activeTag, this._activeAnchor, this._cloudData);
  }

  /** Node-type bucket used for colouring + the legend filters. */
  _kindOf(tag) {
    return tagKind(tag); // year / geo / tag — shared with the pills + tags graph
  }

  /**
   * Build the on-map cloud from a place's fetched payload (`cloudData`): chips
   * for its ≤10 popular co-tags and ≤10 recent posts, wired together with the
   * membership + hierarchy edges that payload carries. The clicked tag sits at
   * the centre (the marker / polygon itself); everything else fans out on rings
   * around it. Legend-hidden node types are dropped.
   */
  _spawnCloud(tag, anchorLatLng, cloudData) {
    const L = window.L;
    if (!cloudData) return;
    const hidden = this._hiddenTypes;
    const centerKey = "t" + tag.id;

    // Satellite tag chips (the popular co-tags; the centre is excluded by the
    // backend). The "Place" toggle hides geo chips here (via _hiddenTypes) while
    // leaving the map markers — and the selected place's own centre chip — untouched.
    const tagSats = [];
    (cloudData.tags || []).forEach((t) => {
      if (t.id === tag.id) return;
      const kind = this._kindOf(t);
      if (hidden.has(kind)) return;
      tagSats.push({
        key: "t" + t.id,
        kind,
        label: t.name,
        href: `/tags/${t.slug}`,
        max: 26,
      });
    });

    const postSats = [];
    if (!hidden.has("post")) {
      const useThumbnails =
        (store.get("settings") || {}).use_thumbnails !== false;
      (cloudData.posts || []).forEach((p) => {
        postSats.push({
          key: "p" + p.id,
          kind: "post",
          label: p.title || p.slug,
          href: `/posts/${p.slug}`,
          max: 24,
          // Image posts reveal a thumbnail when their place is selected.
          thumb: useThumbnails ? p.media_url || null : null,
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
          : { color: "#8a93a6", weight: 1.6, opacity: baseOpacity, dashArray: "3 4" };
      const line = L.polyline([llOf(nodePos.get(a)), llOf(nodePos.get(b))], {
        ...style,
        className: "atlas-link",
        interactive: false,
      });
      this._cloudLines.addLayer(line);
      edges.push({ a, b, line, baseOpacity });
    };
    (cloudData.hierarchyEdges || []).forEach((e) =>
      addEdge("t" + e.parent, "t" + e.child, "hier"),
    );
    (cloudData.membershipEdges || []).forEach((e) =>
      addEdge("p" + e.post, "t" + e.tag, "memb"),
    );

    const sats = ordered.map((node, i) => {
      const ll = llOf(nodePos.get(node.key));
      // Image posts lead with a thumbnail tucked into the chip; the modifier
      // class lets the CSS reshape the pill around it.
      const thumbUrl = node.thumb && safeUrl(node.thumb);
      const thumbHtml =
        thumbUrl && thumbUrl !== "#"
          ? `<img class="atlas-node__thumb" src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />`
          : "";
      const thumbClass = thumbHtml ? " atlas-node--has-thumb" : "";
      const icon = L.divIcon({
        className: "atlas-node-wrap",
        html: `<span class="atlas-node atlas-node--${node.kind}${thumbClass}" style="animation-delay:${i * 16}ms" title="${escapeHtml(node.label)}">${thumbHtml}${escapeHtml(truncate(node.label, node.max))}</span>`,
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

    // The selected place's title sits on its own dot at the centre, so the active
    // node reads as a chip like the rest of the cloud instead of a bare marker.
    // It's pinned to the anchor latlng, so it stays put across zoom without
    // needing repositioning, and is the sole click target that opens the tag page.
    const centerKind = this._kindOf(tag);
    const centerIcon = L.divIcon({
      className: "atlas-node-wrap",
      html: `<span class="atlas-node atlas-node--${centerKind} atlas-node--center" title="${escapeHtml(tag.name)}">${escapeHtml(truncate(tag.name, 30))}</span>`,
      iconSize: [0, 0],
    });
    const centerMarker = L.marker(anchorLatLng, {
      icon: centerIcon,
      keyboard: false,
      riseOnHover: true,
    });
    // The centre title chip is the only way to open the place's tag page —
    // clicking the place's shape/marker recentres the cloud instead. It follows
    // the same two-click model as the satellite chips: the first click focuses
    // it (lighting its connections), a second click on the focused centre opens
    // the tag page.
    centerMarker.on("click", (e) => {
      L.DomEvent.stop(e);
      this._focusCloudNode(centerKey, `/tags/${tag.slug}`);
    });
    this._cloudMarkers.addLayer(centerMarker);

    this._cloud = {
      anchorLatLng,
      nodePos,
      sats,
      edges,
      cloudNeighbors,
      centerKey,
      centerMarker,
      focusKey: null,
    };

    // Open the cloud as a full overview — every chip the place touches is lit.
    // Dimming only kicks in once the user focuses a specific chip.
    this._applyCloudFocus();
  }

  /**
   * Chip click — two-click model matching the /tags graph: the first click on a
   * chip highlights its connections (dimming the rest), a second click on the
   * same chip opens it. Clicking a different chip moves the highlight.
   */
  _focusCloudNode(key, href) {
    if (!this._cloud) return;
    if (this._cloud.focusKey === key) {
      // Opening a post: leave a marker so closing it returns to the Atlas with
      // this place reselected and the post chip highlighted (consumed in
      // PostContent.onClose → handed back via `atlasReturn`).
      if (key[0] === "p" && this._activeTag) {
        try {
          sessionStorage.setItem(
            "atlasOpenContext",
            JSON.stringify({ placeTagId: this._activeTag.id }),
          );
        } catch { /* ignore */ }
      }
      navigate(href);
      return;
    }
    this._cloud.focusKey = key;
    this._applyCloudFocus();
  }

  /**
   * Activate a place by its tag id (programmatic equivalent of a map click).
   * `opts` is forwarded to _select (e.g. focusPostSlug for post returns).
   */
  _selectPlaceById(tagId, opts = {}) {
    const a = this._placeActivators.get(tagId);
    const tag = this._tagsById.get(tagId);
    if (!a || !tag) return false;
    this._select(tag, a.latLng, a.setActive, a.key, opts);
    return true;
  }

  /**
   * Consume an `atlasReturn` handoff (left by closing a post opened here):
   * reselect the place that was active when the post opened (carried as
   * `placeTagId`) and focus the post's chip once its cloud loads. Without global
   * post data there's no fallback — if the place is gone, we simply don't restore.
   */
  _restoreFromPost() {
    let ctx = null;
    try {
      const raw = sessionStorage.getItem("atlasReturn");
      if (!raw) return;
      sessionStorage.removeItem("atlasReturn");
      ctx = JSON.parse(raw);
    } catch { return; }
    if (!ctx || !ctx.postSlug || ctx.placeTagId == null) return;

    this._selectPlaceById(ctx.placeTagId, { focusPostSlug: ctx.postSlug });
  }

  /** Nudge the map so a cloud chip (or the anchor) sits comfortably in view. */
  _panToCloudNode(key) {
    if (!this._cloud || typeof this._map.panInside !== "function") return;
    const sat = this._cloud.sats.find((s) => s.key === key);
    const ll = sat ? sat.marker.getLatLng() : this._cloud.anchorLatLng;
    if (ll) this._map.panInside(ll, { padding: [120, 120] });
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

  /**
   * Apply the current cloud focus to chip + connector styling. The centre place
   * is the cloud's subject, so with no satellite chip focused — the initial
   * overview, or after returning focus to the centre — the whole cloud stays
   * lit, showing everything the place touches. Dimming (and the dashed "related"
   * ring) engages only once a satellite chip is focused, narrowing to that
   * chip's direct + tag→post→tag connections.
   */
  _applyCloudFocus() {
    if (!this._cloud) return;
    const { sats, edges, focusKey, centerKey, centerMarker } = this._cloud;
    // Focusing the centre re-shows the full overview — every chip lit, exactly
    // as the cloud first opened. The centre is the cloud's subject, so
    // "selecting" it means lighting everything it touches rather than narrowing
    // to a single chip's connections.
    const data =
      focusKey && focusKey !== centerKey
        ? this._expandCloudFocus(focusKey)
        : null;
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
        !!(related && related.has(s.key) && focusKey && focusKey !== s.key),
      );
    }

    // The centre place is the cloud's subject. In the overview (no chip focused)
    // it stays the bold, lit anchor; when it is itself focused it keeps that
    // selected look. Once a *different* chip is focused the centre is no longer
    // the active selection, but every cloud node is a connection of the place,
    // so it must stay visible — it only sheds its filled accent for a plain
    // outline (never dimmed) to show it's no longer selected.
    const centerEl = centerMarker?._icon?.firstElementChild;
    if (centerEl) {
      centerEl.classList.toggle(
        "atlas-node--center-blur",
        !!focusKey && focusKey !== centerKey,
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
    this._cloudData = null;
    this._cloudReq++; // invalidate any in-flight cloud fetch for the cleared place
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
