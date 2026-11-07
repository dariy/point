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
| `mapList` | `split` | The map comes down from behind the header (the stack layout; for touch landscape, see below). The post list is one row of cards on the footer, `clamp(96px, 22dvh, 220px)` high (`--atlas-layer-row-h`). The cards fill the row width. The footer is one line at the bottom, with the paginator in it. The edge page arrows do not show. |
| `map` | `map` | The map fills the space below the header. The post list is only the handle, on the footer. The footer is one line at the bottom, without the paginator. |

### Touch landscape

With touch input (`html:not(.pointer-fine)`, and no mouse by the media query) in landscape,
`atlasLayerLayout.ts::watchAtlasSide` sets `body[data-atlas-side]`. Then `mapList` is a side
layout: the map is a square on the left, from the top to the bottom of the viewport, with the
width `--atlas-layer-map-w = min(100dvh, 100vw - 20rem)`. The header, the list and the
footer are in the column on the right. In `mapList` and `map` the handle is a vertical bar on
the map's right edge (see [Gestures](#gestures)). HeaderFold folds the header for the column
width. The list is a grid of square cards that scrolls. `gridFit.ts::computePerPage` fits the
page to the column: whole rows, enough to fill its height. A rotation or a change of input
changes the layout without a reload, and the map keeps its centre. `list` and `map` keep the
layout of the table above; in `map` the handle is the vertical bar on the right edge.
The post viewer (`immersive-sheet`) uses the same test for its own side layout: see
[Touch landscape](immersive-sheet.md#touch-landscape) there.

The map shows only the posts of the current list (same filter as the cards). The page
does not wait for the map: see [Warm-up](#warm-up).

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
- **Touch landscape** (`body[data-atlas-side]`): a horizontal drag on the vertical handle
  changes the map width (`--atlas-layer-map-w`, set inline during the drag). To the left
  the map gets smaller (`map` → `mapList` → `list`), to the right it grows. The snap and
  the flick are the same as in y. The drag shows the layout of the state it snaps to: the
  split for `list` and `mapList`, the map under the header for `map`. In `list` the handle
  is still the bar at the top of the list: a drag in either axis opens the map, and the
  pull down stays vertical. The list column is not a drag surface: a finger scrolls it, and
  the page swipe (`core/gridPager.ts`) ignores a gesture that starts on the handle.
- **Tap or click** on the handle: `list` → `mapList` → `map` → `list`.
- **Wheel** over the handle: one step for each gesture.
- **Keyboard** on the handle: Enter or Space cycles, ArrowDown goes forward, ArrowUp
  goes back, Escape goes to `list`. In touch landscape ArrowRight also goes forward and
  ArrowLeft back.

### Map taps

- **Tap on a place** (a country shape or a marker): the place is selected, and its tag
  page `/tags/<slug>` opens. The list shows the posts of that place.
- **Tap on the place that is open**: the cloud moves to the tap point. The route does not
  change.
- **Tap on empty map** (the sea, or a country with no geo-tag): the selection is cleared.
  On `/tags/<slug>`, the home page `/` opens. On `/`, only the selection is cleared.
- **Tap on a cluster dot**: the map fits the places of the cluster. No place is selected,
  and the route does not change. See [Clusters](#clusters).

When the layer map is 320 px high or less (a short window, or a small phone on its side), the
legend is one button to the right of the zoom control. The button opens the filters in one row.

### Place search

The legend starts with a search button. It opens a field ("Find a place"). The field finds
the places that the map draws, by name, case and accent insensitive (`zur` finds Zürich). A
name that starts with the text comes first, then a name that contains it. In each group, the
place with more posts comes first. The list shows 8 places or fewer, above the field.

- **Arrow keys** move the choice. **Enter** or a **tap** picks the place.
- **A pick** flies the map to the place: a marker at zoom 10 (or the current zoom, if it is
  larger), a country or state shape to fit its bounds. The place opens its cloud, and its tag
  page `/tags/<slug>` opens, as for a tap on the place.
- **Escape** closes the field. An empty field, or a text with no match, shows no list.
- A hidden place is in the list only while the "Hidden" filter shows it.
- The sheet window shows no legend, so it has no search. On a short map, the search is in
  the folded legend.

The matcher is `atlasSearch.ts::matchPlaces`; `AtlasPlaces.ts::_mountSearch` and
`pickPlace` draw the field and do the pick. Under `prefers-reduced-motion: reduce`, the pick
moves the map with no animation.

### Labels

A place marker is one pill. It has two states:

- **Collapsed:** the dot only.
- **Expanded:** the dot and the name in one pill, `[● Berlin]`.

A tap anywhere on the pill, on the dot or on the name, selects the place and opens its
cloud. It does not open the tag page. In the sheet window, a tap opens the full map, as
all window taps do.

A pill expands in these cases:

- **The label pass gives it space.** The pass measures the box of the whole pill. The
  places with more posts go first: a pill expands only if it does not cover a pill that is
  already expanded, or the dot of another place. A zoom in thus expands more pills. The
  pass runs again after each zoom and move, on the full map, in `mapList` and in the sheet
  window. In a window, only the places in the visible part of the window count. An open
  cloud is taken space: a pill below a chip of the cloud stays collapsed.
- **Hover or a long press.** With a mouse, a pill expands on hover and collapses on leave.
  On touch, a press of 450 ms with less than 6 px of movement expands the pill. The release
  collapses it after 1.5 s. A long press does not open the cloud and does not pan the map.
  A short tap works as before. The sheet window expands no pill on hover or a long press.
  The timer is `atlasPeek.ts::createLongPress`.
- **The place is selected.** While its cloud does not show (the cloud loads, or there is
  no cloud), the selected pill goes first in the pass and is always expanded. The other
  pills go around it. While the cloud shows, the cloud's centre chip is the expanded form
  of the place: the pill stays collapsed under the chip.

The expanded pill shows the name only, not the post count. A place marker has no native
tooltip; its accessible name is the place name. A tagged country or state shows its name
at the place's own point, with the same pass; this label takes no taps, so a tap goes to
the shape below it. The pill of a hidden place is dimmed. The pass is
`atlasLabels.ts::declutter`; `AtlasPlaces.ts::pillBox` gives the pill box.

### Clusters

At a low zoom the dots of a dense area overlap. Two dots that overlap by more than half the
radius of the smaller dot merge into one cluster dot. The cluster dot shows the number of
places. Its size follows the sum of the post counts, with the same rule as a place dot. It sits
at its largest place. It is a pill like a place marker: expanded, it shows
`[● <largest place> +N]` (N = the other places). The label pass gives it space like a place
pill, and it expands on hover.

- The pass is greedy: the places go largest first. A place that is in no cluster starts one
  and takes each free place whose dot overlaps its own dot.
- The pass runs on each zoom, not on a move: a pan does not change the distance between two
  dots. It runs again when a place opens or closes and when a window gets its place.
- A tap on a cluster fits the map to its places. At the maximum zoom (18) no cluster forms,
  so a tap always splits a cluster. Places at the same point stay stacked at zoom 18.
- The open place (its cloud is open) is never inside a cluster. In the sheet window, the
  post's own place is never inside a cluster.
- In the sheet window, a tap on a cluster opens the full map, as all window taps do.

The pass is `atlasLabels.ts::clusterDots`; `AtlasPlaces.ts::_applyClusters` draws it.

## One map for the visit

One module owns the map: `atlasOcean.ts`. It keeps the container, the Leaflet map, the
tiles and the places until the page unloads or `tags-atlas` is off. A list page attaches
to it and detaches from it. A page never makes or destroys the map. A page asks for a
presentation:

| Presentation | When | What you see |
|--------------|------|--------------|
| `hidden` | The `list` state, and every page that is not a list page | No map. The map stays in memory. |
| `mapList` | The `mapList` state | The map above the card row. |
| `full` | The `map` state | The map below the header. |
| `window` | The Details sheet of a post with a place tag | The map through the sheet's map slot. |

A move between list pages (`/` and `/tags/<slug>`) does not rebuild the map. This is
also true for Back, Forward and a tag link. The same map stays, with the same viewport
and tiles, and it does not fit to the places again. A move to any other page (a post,
search, admin) sets `hidden` and keeps the map. A return to the list page shows the same
map at the same viewport.

### Warm-up

A list page that opens in the `list` state builds the map when the browser is idle,
after the first grid render. The first photos load first. The map is built with
`visibility: hidden`, so it keeps its size, and the places load. The first change to
`mapList` or `map` then only shows the map. When the browser asks to save data
(`navigator.connection.saveData`), there is no warm-up: Leaflet loads on the first change
out of `list`.

A visit that starts on a post builds the map only when the Details sheet opens on a post
with a place tag. A post with no place tag loads no Leaflet.

### The window

The `window` presentation does not make a second map, and it does not resize the map.
The container keeps its size, moves above the post viewer and is clipped to a rectangle
(`clip-path: inset(…)`). A click outside the rectangle goes to the page below. The view
moves so that the place is at the centre of the rectangle. The clip follows the slot
while the sheet drags, slides and scrolls. See
[immersive-sheet.md](immersive-sheet.md) for the slot. In the window, drag and pinch
move the map. A tap, also a tap on a place marker, opens the full map, not the place's
tag page. With `tags-atlas` off, the sheet has no slot and no map.

A rotation changes the size of the container. Then the map gets a new clip and a new
offset at once. When the sheet's layout is stable, the sheet gives the new slot, and the
map moves with the centre of the slot. Thus the point at the centre of the window stays
at the centre of the new slot.

A change between `window` and `full` is one motion: the clip grows or shrinks, and the
place moves to the new centre. The zoom does not change during the motion. Leaflet runs
with `zoomAnimation: false`, and the new zoom comes after the clip motion stops. With
`prefers-reduced-motion: reduce`, each change of presentation is instant.

A window that a page puts on a place (`AtlasWindow.place`, with `center`) opens that
place's cloud with one ring (`maxRings: 1`); chips outside the window are not drawn. The
move into a window first closes the cloud that was open. A tag page of the same place
opens the full cloud again: a one-ring cloud never counts as the route's selection.

After a tap in the window, the tag page selects the place and opens its cloud. Until the
tag page attaches, only `hidden` stops this. A new window from the post (a re-render, a
resize) or a state change does not stop it. For 500 ms after the tag page attaches, the
full map ignores clicks, so a late click of the tap does not clear the place.

If the tag page does not come, the map does not stay over the page. The ocean hides it
when one of these occurs: no attach in 8 s (`EXPAND_HOLD_MS`), a route to a page that
is not the tag page, or a tag page load error (`TagPage.ts` calls
`releaseAtlasExpand`). The user sees the tag page's error. A viewer that is still on
screen removes its fade and puts the window back on its slot.

A Back from the full map to a post whose sheet map opened it does not hide the map. The
map stays on screen and shrinks into the sheet's map slot. While the full map's history
entry has `fromPost`, a "‹ <post title>" chip at the top goes back to that post.

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
