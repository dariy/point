# Tags Atlas (`tags-atlas`)

**Type:** route · **Slot:** `map-route` (cardinality `0-1`) · **Routes:** `/map` · **Default:** enabled

With this plugin on, every post list page (home, tag, search) gets a map layer. The layer
is collapsed by default. A grab handle at the top of the post list shows that a map is
available.

## States

The page has three states. The state is on `<body>` as `data-atlas-layer`, and the CSS
reads only that attribute.

| State | `?view=` | What you see |
|-------|-----------|--------------|
| `list` | `list` | The page as it is, plus the handle. The footer shows. |
| `mapList` | `split` | The map comes down from behind the header. The post list is one row of cards on the footer, `clamp(96px, 22dvh, 220px)` high (`--atlas-layer-row-h`). The cards fill the row width. The footer is one line at the bottom, with the paginator in it. The edge page arrows do not show. |
| `map` | `map` | The map fills the space below the header. The post list is only the handle, on the footer. The footer is one line at the bottom, without the paginator. |

The map shows only the posts of the current list (same filter as the cards). It loads
(Leaflet, post data, tiles) on the first change out of `list`. A page that stays in
`list` makes no map request.

## Gestures

These controls take a gesture that changes the state: the handle in every state, the card
row in `mapList`, the footer background in `mapList` and `map`, and the post list in
`list`. A gesture that starts inside the map goes to the map (pan, pinch, wheel zoom).

- **Swipe or mouse drag** on the handle or the card row: the handle follows the finger.
  On release it goes to the nearest state, or one state in the direction of a flick
  (0.5 px/ms or faster). A horizontal move scrolls the cards.
- **Swipe** on the footer in `mapList` and `map`: the same as on the handle. A swipe
  that starts on a button, a link, an input or the paginator does not change the state,
  and a tap on one of them does only its own action.
- **Pull down** on the post list in `list`: anywhere on the post list, when the page is
  at scroll top, the handle follows the finger and the map opens. When the page is
  scrolled down, the move scrolls the page as usual. A pull uses touch events. The page
  root has `overscroll-behavior-y: contain`, so the browser pull-to-refresh does not
  start on a list page.
- **Tap or click** on the handle: `list` → `mapList` → `map` → `list`.
- **Wheel** over the handle: one step for each gesture.
- **Keyboard** on the handle: Enter or Space cycles, ArrowDown goes forward, ArrowUp
  goes back, Escape goes to `list`.

### Map taps

- **Tap on a place** (a country shape or a marker): the place is selected, and its tag
  page `/tags/<slug>` opens. The list shows the posts of that place.
- **Tap on the place that is open**: the cloud moves to the tap point. The route does not
  change.
- **Tap on empty map** (the sea, or a country with no geo-tag): the selection is cleared.
  On `/tags/<slug>`, the home page `/` opens. On `/`, only the selection is cleared.

A move between list pages (`/` and `/tags/<slug>`) does not rebuild the map. This is
also true for Back, Forward and a tag link. The same map stays, with the same viewport
and tiles, and it does not fit to the places again. The old page parks the map
(`atlasLayerHost.ts`) and the new page takes it. A move to any other page (a post,
search, admin) destroys the map.

When the layer map is less than 320px high (a phone on its side), the legend is one
button to the right of the zoom control. The button opens the filters in one row.

## URL

The state is in the query string. A state change uses `history.replaceState`, so a
swipe does not add a history entry. The map viewport is in `?at=<lat>,<lng>,<zoom>`.
Each change also saves the state in `localStorage` (`atlasLayerState`). On load, the `view`
parameter wins, then the saved state, then `list`. An invalid `view` value is ignored. Old
`?atlas=list-map|map` links still open their state.
A reload or a shared link opens the same state and viewport.

When a post opens from `mapList` or `map`, a close of the post returns to the list URL,
with the same state and viewport. A tag link to another list page keeps the state.

## `/map`

`/map` redirects to the home list in the `map` state (`/?view=map`). Old query
parameters stay on the URL. The redirect does not depend on the `tags_visibility`
setting.

`tags-atlas` and [`tags-map`](tags-map.md) are the two candidates for the `map-route`
slot, which takes at most one: enabling one disables the other, and the enabled one owns
`/map`. With neither enabled, the route disappears. [`tags-graph`](tags-graph.md) is not
a competitor: it sits in its own slot on `/tags` and can be enabled alongside a map.

See [Tags Visualization](../features/tags-visualization.md) for the comparison of the
three providers.
