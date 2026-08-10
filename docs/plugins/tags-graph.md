# Tags Graph (`tags-graph`)

**Type:** route · **Slot:** `tags-route` (cardinality `0-1`) · **Routes:** `/tags` · **Default:** disabled

A canvas force-directed graph alternative for the public `/tags` route
(`frontend/src/plugins/tags-graph/tagGraph.js`). Makes two relationship types
explicit: parent/child hierarchy edges, and "related-through-post" edges, where every
post is a small shadow node linking each tag it carries — two tags read as related
because a shared post node sits between them. Node radius scales with degree; supports
drag, pan/zoom, hover highlighting, and click-to-navigate. A visually-hidden
alphabetical tag list provides a keyboard/screen-reader fallback.

Competes for the `tags-route` slot with [`tags-atlas`](tags-atlas.md) (default) and
[`tags-map`](tags-map.md); the slot takes a single claimant, so enabling this plugin
automatically disables its two siblings.

See [Tags Visualization](../features/tags-visualization.md) for details.
