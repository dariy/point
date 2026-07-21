# Tags Graph (`tags-graph`)

**Type:** route · **Slot:** `tags-route` · **Routes:** `/tags` · **Area:** `tags-viz` (exclusive) · **Default:** disabled

A canvas force-directed graph alternative for the public `/tags` route
(`frontend/src/plugins/tags-graph/tagGraph.js`). Makes two relationship types
explicit: parent/child hierarchy edges, and "related-through-post" edges, where every
post is a small shadow node linking each tag it carries — two tags read as related
because a shared post node sits between them. Node radius scales with degree; supports
drag, pan/zoom, hover highlighting, and click-to-navigate. A visually-hidden
alphabetical tag list provides a keyboard/screen-reader fallback.

Shares the `tags-viz` area with [`tags-atlas`](tags-atlas.md) (default) and
[`tags-map`](tags-map.md) — `Exclusive: true` means enabling this plugin automatically
disables its two siblings.

See [Tags Visualization](../features/tags-visualization.md) for details.
