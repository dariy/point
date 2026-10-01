# Tags Atlas (`tags-atlas`)

**Type:** route · **Slot:** `map-route` (cardinality `0-1`) · **Routes:** `/map` · **Default:** enabled

The default provider for the public `/map` route. Plots every geo-tag on a Leaflet map
— country shapes where the name matches a boundary file, circle markers elsewhere — and
reveals a place's posts and co-tags as a cloud of chips anchored to it on the map.

The timeline scopes the map: places with no posts in the selected year range drop off
it, and the rest are resized by their in-range count. Both the place layer and the open
place's cloud are year-scoped server-side, and the range rides in the URL as
`?timeline=<from>-<to>`.

The cloud shows only the most recent posts of a place. On a desktop window (64em and
wider), a click on a place also opens a side panel. The panel shows the place name, its
post count, and all its posts, page by page from `/api/pages/tags/<slug>`. "More posts"
loads the next page. The list uses the timeline range, and with the "Hidden" legend
toggle off it skips hidden, draft and scheduled posts. A click on a post opens it, and a
close of the post returns to the place, as from a cloud chip. A click on empty map or on
the close button closes the panel. Below 64em there is no panel, only the cloud.

`tags-atlas` and [`tags-map`](tags-map.md) are the two candidates for the `map-route`
slot, which takes at most one: enabling one disables the other, and the enabled one owns
`/map`. With neither enabled, the route disappears — the one difference from the
`post-viewer` slot, which always keeps a claimant. [`tags-graph`](tags-graph.md) is not
a competitor: it sits in its own slot on `/tags` and can be enabled alongside a map.

See [Tags Visualization](../features/tags-visualization.md) for the full comparison of
the three providers.
