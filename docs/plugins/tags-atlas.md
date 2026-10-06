# Tags Atlas (`tags-atlas`)

**Type:** route · **Slot:** `map-route` (cardinality `0-1`) · **Routes:** `/map` · **Default:** enabled

The default provider for the public `/map` route. Plots every geo-tag on a Leaflet map
— country shapes where the name matches a boundary file, circle markers elsewhere — and
reveals a place's posts and co-tags as a cloud of chips anchored to it on the map.

The timeline scopes the map: places with no posts in the selected year range drop off
it, and the rest are resized by their in-range count. Both the place layer and the open
place's cloud are year-scoped server-side, and the range rides in the URL as
`?timeline=<from>-<to>`.

The cloud shows only the most recent posts of a place. A click on a place also opens a
bottom sheet, at every width. The sheet shows one row of square post cards, the place
name with its post count, and a compact paginator. The page size is the number of cards
that fit in the row. A swipe, the arrow keys or the paginator go to the next page. The
cards use the timeline range, and with the "Hidden" legend toggle off they skip hidden,
draft and scheduled posts. A grip click, a swipe down or Esc collapses the sheet to a
pill, and the pill opens it again on the same page. A click on empty map closes the
sheet. A card or a cloud post chip opens the post inside the place's tag
(`/tags/<place>?slug=<post>`), so previous/next stay in that place. A close of the post
returns to `/map` with the place and the sheet page.

`tags-atlas` and [`tags-map`](tags-map.md) are the two candidates for the `map-route`
slot, which takes at most one: enabling one disables the other, and the enabled one owns
`/map`. With neither enabled, the route disappears — the one difference from the
`post-viewer` slot, which always keeps a claimant. [`tags-graph`](tags-graph.md) is not
a competitor: it sits in its own slot on `/tags` and can be enabled alongside a map.

See [Tags Visualization](../features/tags-visualization.md) for the full comparison of
the three providers.
