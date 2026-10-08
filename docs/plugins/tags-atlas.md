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

Only the handle and the card row take a gesture that changes the state. A gesture that
starts inside the map goes to the map (pan, pinch, wheel zoom).

- **Swipe or mouse drag** on the handle or the card row: down goes one state toward
  `map`, up goes one state back. The threshold is 40px or 0.5 px/ms. A shorter drag
  snaps back. A horizontal move scrolls the cards.
- **Tap or click** on the handle: `list` → `mapList` → `map` → `list`.
- **Wheel** over the handle: one step for each gesture.
- **Keyboard** on the handle: Enter or Space cycles, ArrowDown goes forward, ArrowUp
  goes back, Escape goes to `list`.
- **Buttons** on the handle: in `mapList`, a map icon at the start ("Maximize map") and
  a grid icon at the end ("Maximize list"). In `list` and `map`, a split icon ("Restore
  map and list"). Each button is a 44px target.

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
