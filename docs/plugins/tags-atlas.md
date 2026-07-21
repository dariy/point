# Tags Atlas (`tags-atlas`)

**Type:** route · **Slot:** `tags-route` · **Routes:** `/tags` · **Area:** `tags-viz` (exclusive) · **Default:** enabled

The default provider for the public `/tags` route. Renders a hierarchical directory of
every public tag with thumbnails and post counts, breadcrumb-aware, with client-side
filter-as-you-type. It is the "sitemap" view of the blog — exhaustiveness over
curation, favoring a plain list/grid over a spatial or graph metaphor.

`tags-atlas`, [`tags-map`](tags-map.md), and [`tags-graph`](tags-graph.md) share the
`tags-viz` area with `Exclusive: true`: at most one may be enabled at a time (enabling
one disables the other two), and the enabled one owns `/tags`. With none enabled, the
route disappears.

See [Tags Visualization](../features/tags-visualization.md) for the full comparison of
the three providers.
