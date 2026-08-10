# Tags Visualization (`/tags`) — Atlas, Map, Graph

The public `/tags` route is a **single-claim plugin slot** (`tags-route`, cardinality
`0-1` in `SlotCardinality` — see `api/internal/plugins/registry.go`): one of three
plugins owns it, selectable from `/light/plugins`, and with none enabled the route is
hidden altogether.

## The three providers

### `tags-atlas` (default, Leaflet)

"Tags on the map". Every geo-tag is plotted — as a country/subdivision polygon when its
name matches a boundary file, otherwise as a circle marker sized by post count. Clicking
a place opens its **cloud**: its recent posts and most popular co-tags fan out on rings
around it *on the map*, wired to it and to each other by membership and hierarchy edges,
and staying pinned to the place across pan and zoom. Chips follow a two-click model —
the first focuses (lighting that chip's connections and dimming the rest), the second
opens.

Two endpoints feed it, both year-scopable:

- `GET /api/pages/graph?posts=0` — the places themselves. The Atlas skips the full post
  set because each place fetches its own on tap.
- `GET /api/pages/graph/tag/:id` — one place's cloud (≤`atlas_post_limit` recent posts,
  ≤10 popular co-tags, and the edges among them), cached per place *and* year range.

**Timeline filtering.** The timeline scopes the map itself, not just the open cloud:
both endpoints take `year_from`/`year_to`, places with nothing left in range drop off
the map, and the survivors are resized by their in-range count. A range change redraws
the live Leaflet layers rather than re-rendering the page — a re-render would tear down
and rebuild the map and the timeline on every drag of the handle. The scope also rides
in the URL (`?timeline=`), so a shared link opens on the same map.

Scoped counts roll up the hierarchy (`GetHierarchicalPostCountsInYearRange`), which is
load-bearing rather than a nicety: posts are usually tagged with a city and not its
country, so counting only direct tags would drop every country polygon the moment the
timeline narrowed — emptying the Atlas of the shapes it is built around.

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
  slot's cardinality is the generic form of the old radio setting, shared with the
  `post-viewer` slot (which differs only in that it may not be left empty).

- **The Atlas filters places, the map filters markers** — `tags-map` scopes its markers
  with a flat per-tag count (`ListMapTagsForYearRange`), so a country tagged only through
  its cities disappears there under a year filter. The Atlas deliberately does not share
  that query.

## Out of scope

- Timeline date-range slicing inside the graph (year nodes stand in).
- Geography behavior inside the graph (owned by the map provider) — geo-tags get a
  visual indication only.
