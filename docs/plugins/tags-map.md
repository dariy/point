# Tags Map (`tags-map`)

**Type:** route · **Slot:** `map-route` (cardinality `0-1`) · **Routes:** `/map` · **Default:** disabled

A Leaflet world map alternative for the public `/map` route: country polygon fills for
country-type tags, proportional circle markers for city/place tags with
`latitude`/`longitude`, clicking a marker navigates to that tag's archive. Supports year
filtering via the [timeline](timeline.md). Leaflet is vendored and lazy-loaded per page
(`frontend/src/utils/leaflet.js`) so it never enters the core app bundle.

Competes for the `map-route` slot with [`tags-atlas`](tags-atlas.md), the default map;
the slot takes a single claimant, so enabling this plugin automatically disables the
Atlas. [`tags-graph`](tags-graph.md) is unaffected — it claims `/tags` through its own
slot and may run at the same time.

See [Tags Visualization](../features/tags-visualization.md) for details.
