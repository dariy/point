# Tags Visualization (`/tags`) — Atlas, Map, Graph

The public `/tags` route is a **single-claim plugin slot** (`tags-route`): exactly one
of three mutually-exclusive plugins (`Area: "tags-viz"`, `Exclusive: true` in
`api/internal/plugins/registry.go`) owns it, selectable from `/light/plugins`.

## The three providers

### `tags-atlas` (default)

Hierarchical tags directory: every public tag with thumbnails and post counts,
breadcrumb-aware, with client-side filter-as-you-type. The "sitemap" view where
exhaustiveness beats curation.

### `tags-map` (Leaflet)

World map of geo-tags (tags with `latitude`/`longitude`): country polygon fills for
country-type tags, proportional circle markers for cities; clicking a marker navigates
to the tag archive. Supports year filtering via the timeline. Leaflet is vendored and
lazy-loaded per page (`frontend/src/utils/leaflet.js`) so it never enters the core
bundle. A fetch failure must render a visible error state, not a silent empty map.

### `tags-graph` (force graph)

Canvas force-directed graph (`frontend/src/plugins/tags-graph/tagGraph.js`) making two
relationship types explicit:

1. **Parent/child** — hierarchy edges (solid/accent).
2. **Related-through-post** — every post is a small "shadow" node linked to each tag it
   carries (thin/faint edges); two tags read as related because a shared post node sits
   between them.

Four node kinds with fixed precedence: year-tag (`kind='year'`) → geo-tag (has
coordinates) → plain tag; plus post nodes. Node radius ∝ degree. Interactions: drag
(pin while dragging), hand-rolled canvas pan/zoom (wheel + background drag), hover
highlights node + neighbors, click navigates to the tag archive or post. A
visually-hidden alphabetical `<ul>` of tag links is the keyboard/screen-reader
fallback; `prefers-reduced-motion` is respected.

**Backend**: `GET /api/pages/graph` returns
`{tags, posts, hierarchyEdges, membershipEdges}` in bulk, honoring visibility
(guests never receive effectively-hidden tags or unpublished posts).

## Key decisions

- **Canvas, not SVG** — hundreds of nodes plus thousands of membership edges make SVG
  DOM too slow for dragging.
- **Vendored force layout, lazy-loaded** (`frontend/vendor/d3-force/`), mirroring the
  Leaflet pattern — keeps heavy viz code out of `app.js`.
- **All posts are shadow nodes** — single-tag posts are rare; a toggle to hide them is
  a supported-by-data future option, deliberately not built.
- **Year nodes are only explicit `kind='year'` tags** — never derived from a post's
  `created_at`.
- **Exclusivity via the plugin system** rather than a `tags_module` setting — the
  registry's `Exclusive`/`Area` mechanism is the generic form of the old radio setting.

## Out of scope

- Timeline date-range slicing inside the graph (year nodes stand in).
- Geography behavior inside the graph (owned by the map provider) — geo-tags get a
  visual indication only.
