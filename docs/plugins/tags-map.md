# Tags Map (`tags-map`)

**Type:** route · **Slot:** `tags-route` · **Routes:** `/tags` · **Area:** `tags-viz` (exclusive) · **Default:** disabled

A Leaflet world map alternative for the public `/tags` route: country polygon fills for
country-type tags, proportional circle markers for city/place tags with
`latitude`/`longitude`, clicking a marker navigates to that tag's archive. Supports year
filtering via the [timeline](timeline.md). Leaflet is vendored and lazy-loaded per page
(`frontend/src/utils/leaflet.js`) so it never enters the core app bundle.

Shares the `tags-viz` area with [`tags-atlas`](tags-atlas.md) (default) and
[`tags-graph`](tags-graph.md) — `Exclusive: true` means enabling this plugin
automatically disables its two siblings.

See [Tags Visualization](../features/tags-visualization.md) for details.
