# Tags Visualization (`/map`, `/tags`) — Atlas, Map, Graph

Three plugins visualize the tag set, across **two single-claim slots** with one public
path each (both `0-1` in `SlotCardinality` — see `api/internal/plugins/registry.go`):

| Path    | Slot         | Candidates                         |
| ------- | ------------ | ---------------------------------- |
| `/map`  | `map-route`  | `tags-atlas` (default), `tags-map` |
| `/tags` | `tags-route` | `tags-graph`                       |

Each slot takes at most one enabled plugin, selectable from `/light/plugins`, and a slot
with none enabled hides its own route altogether. So the two maps are alternatives to
each other, while the graph competes with nothing: it can be enabled next to a map, and
the header then shows two viz buttons, one per live path. `tags_visibility` is a single
shared gate over all three (there is no per-viz visibility).

`/tags` here is the visualization route; the tag archive at `/tags/:slug` is a core page
and is unaffected by any of these plugins.

## The maps (`/map`)

The two are alternatives for the same path. Registry order makes the atlas the winner
when a configuration asks for both.

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

**Owner-only nodes are marked.** Both endpoints have always scoped themselves to the
viewer, so [revelio](hidden-visibility.md#revelio--viewing-the-site-as-a-guest) already
takes hidden places off the map — but losing one marker out of hundreds reads as
nothing happening. So the revealed view says which nodes a guest would not get: a
hidden place is drawn as a hollow dashed dot (dashed outline for a country shape), and
a hidden co-tag or a draft/hidden/scheduled post chip carries the site-wide lock icon
plus a dashed ring. The flags behind it (`is_hidden` on a tag node, `status` on a post
node) are sent only to a viewer who may see hidden items and only when true, so a guest
payload never carries them — with revelio off the marking disappears along with the
nodes. There is no `hidden_via`: hiding is not inherited (see
[hidden-visibility.md](hidden-visibility.md)), so it could only ever name the tag itself.

**The "Hidden" legend filter.** Marking is not enough on its own, because a hidden
*location* changes the map's shape and not just its marker count: a hidden country
stops matching its boundary feature, so its fill reverts to a plain untagged outline —
the guest's map is a different picture, not a shorter list. The legend therefore carries
a fifth toggle that drops every owner-only node from the drawn layers (markers, country
shapes and cloud chips alike), flipping between the owner's map and the guest's in one
click, with no reload and without leaving revelio. Unlike the type filters it redraws
the place layer (`_redrawPlaces`) rather than only the open cloud — filtering a place
out of `_drawLayers`' geo-tag set is exactly what un-matches its shape. It is rendered
only when the viewer can actually be sent hidden nodes (signed in, revelio on);
otherwise it would be a control that does nothing.

With `tags_visibility` at its default (`hidden`) the Atlas is owner-only, so concealing
404s the graph endpoint — the honest guest answer. The page names that ("the Atlas is
not public") instead of showing the raw `tags not found` error, which reads as a broken
page to the owner who just flipped the switch.

### `tags-map` (Leaflet)

World map of geo-tags (tags with `latitude`/`longitude`): country polygon fills for
country-type tags, proportional circle markers for cities; clicking a marker navigates
to the tag archive. Supports year filtering via the timeline. Leaflet is vendored and
lazy-loaded per page (`frontend/src/utils/leaflet.js`) so it never enters the core
bundle. A fetch failure must render a visible error state, not a silent empty map.

Hidden places are marked the same way as on the Atlas — hollow dashed marker, dashed
country outline — alongside the lock its popups already carried (`is_hidden` /
`hidden_via` from `GET /api/pages/map`, admin-only).

## The graph (`/tags`)

The graph is the "all tags" view, so it keeps `/tags` — its historical path — as
`tags-route`'s only candidate today. The slot's rule is declared anyway, so a future
second graph viz cannot silently double-claim the path.

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
- **Hand-rolled force layout** — dependency-free, meaning no D3 to vendor or lazy-load.
- **All posts are shadow nodes** — single-tag posts are rare; a toggle to hide them is
  a supported-by-data future option, deliberately not built.
- **Year nodes are only explicit `kind='year'` tags** — never derived from a post's
  `created_at`.
- **Exclusivity via the plugin system** rather than a `tags_module` setting — slot
  cardinality is the generic form of the old radio setting, shared with the
  `post-viewer` slot (which differs only in that it may not be left empty).
- **Two slots, not one, because only the maps are alternatives** — two maps at once is
  meaningless, a graph next to a map is not. One slot owning `/tags` for all three made
  the graph and the maps switch each other off for no reason; splitting `map-route` out
  lets a site run both, on `/map` and `/tags` respectively. `/map` is the only new
  public path: the graph stays on `/tags`, so no redirect, no broken bookmarks.
- **The Atlas is the default map, not a second path** — it is a Leaflet map with extra
  functionality, so it takes `/map` and `tags-map` is its alternative there.
- **Disabling a viz keeps the pre-split behavior on its path** — `RedirectHome`, per
  route, so `/map` with no map enabled behaves exactly as `/tags` with nothing enabled
  did.
- **The Atlas filters places, the map filters markers** — `tags-map` scopes its markers
  with a flat per-tag count (`ListMapTagsForYearRange`), so a country tagged only through
  its cities disappears there under a year filter. The Atlas deliberately does not share
  that query.

## Out of scope

- Timeline date-range slicing inside the graph (year nodes stand in).
- Geography behavior inside the graph (owned by the map provider) — geo-tags get a
  visual indication only.
