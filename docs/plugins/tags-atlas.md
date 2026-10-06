# Tags Atlas (`tags-atlas`)

**Type:** route · **Slot:** `map-route` (cardinality `0-1`) · **Routes:** `/map` · **Default:** enabled

With this plugin on, every post list page (home, tag, search) gets a map layer. The layer
is collapsed by default. A grab handle at the top of the post list shows that a map is
available.

## States

The page has three states. The state is on `<body>` as `data-atlas-layer`, and the CSS
reads only that attribute.

| State | `?atlas=` | What you see |
|-------|-----------|--------------|
| `list` | (absent) | The page as it is, plus the handle. The footer shows. |
| `mapList` | `list-map` | The map comes down from behind the header. The post list is one row of cards over the footer position, about 20% of the viewport high. The footer is hidden. |
| `map` | `map` | The map fills the space below the header. The post list is only the handle, at the bottom. The footer is hidden. |

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

## URL

The state is in the query string. A state change uses `history.replaceState`, so a
swipe does not add a history entry. The map viewport is in `?view=<lat>,<lng>,<zoom>`.
A reload or a shared link opens the same state and viewport.

When a post opens from `mapList` or `map`, a close of the post returns to the list URL,
with the same state and viewport. A navigation to another list page starts in `list`.

## `/map`

`/map` redirects to the home list in the `map` state (`/?atlas=map`). Old query
parameters stay on the URL. The redirect does not depend on the `tags_visibility`
setting.

`tags-atlas` and [`tags-map`](tags-map.md) are the two candidates for the `map-route`
slot, which takes at most one: enabling one disables the other, and the enabled one owns
`/map`. With neither enabled, the route disappears. [`tags-graph`](tags-graph.md) is not
a competitor: it sits in its own slot on `/tags` and can be enabled alongside a map.

See [Tags Visualization](../features/tags-visualization.md) for the comparison of the
three providers.
