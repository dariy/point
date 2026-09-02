# Tags Graph (`tags-graph`)

**Type:** route · **Slot:** `tags-route` (cardinality `0-1`) · **Routes:** `/tags` · **Default:** disabled

A canvas force-directed graph on the public `/tags` route
(`frontend/src/plugins/tags-graph/tagGraph.js`). Makes two relationship types
explicit: parent/child hierarchy edges, and "related-through-post" edges, where every
post is a small shadow node linking each tag it carries — two tags read as related
because a shared post node sits between them. Node radius scales with degree; supports
drag, pan/zoom, hover highlighting, and click-to-navigate. A visually-hidden
alphabetical tag list provides a keyboard/screen-reader fallback.

Sole candidate for the `tags-route` slot, so it competes with nothing: the maps
([`tags-atlas`](tags-atlas.md), [`tags-map`](tags-map.md)) live in `map-route` on `/map`
and can be enabled next to it. The slot still takes at most one claimant — declared so a
future second graph viz cannot double-claim `/tags` — and with this plugin disabled the
route disappears.

See [Tags Visualization](../features/tags-visualization.md) for details.
