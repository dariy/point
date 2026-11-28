# Immersive — Sheet (`immersive-sheet`)

**Type:** enhancer · **Slot:** `post-viewer` (cardinality `1`) · **Default:** disabled · **Title:** Immersive (Sheet)

An alternative post viewer presentation: full-screen photo with a swipe-up details
sheet, rather than the standard carousel's chrome. Shares most viewer code with
[`immersive`](immersive.md) (esbuild code-splitting dedupes the common modules into a
shared chunk).

The other candidate for the `post-viewer` slot, whose cardinality is `1`: enabling
this plugin disables the standard viewer and vice versa, and the active one of the two
cannot be switched off — a post rendered immersively has nothing else to show.

See [Immersive Mode & Media Viewer](../features/immersive.md) for details.

## Touch landscape

With touch input in landscape, the viewer uses a side layout: the sheet is a
panel at the right of the screen. The test is the same as the map layer's side
split ([`tags-atlas`](tags-atlas.md), Touch landscape): no fine pointer, and a
landscape viewport (`atlasLayerLayout.ts::onAtlasSide`). The viewer wrapper
then has the class `immersive-sheet-side`.

The panel has two states:

- **Shut.** The photo fills the screen. The panel is off the screen on the
  right. A "Details" tab shows at the right edge of the screen.
- **Open.** The panel slides in from the right over the photo (0.34 s). In the
  same time the photo stage shrinks to the area on the left of the panel. The
  photo, the nav panels, the dots and the buttons at the top right (close,
  share, slideshow) use that area. `MediaViewer.ts::_stageWidth` gives the
  width of that area, so a slide moves by the stage width, not the screen
  width.

The inputs:

- The tab, a swipe up on the photo, or ArrowUp opens the panel.
- The grip (a bar on the left edge of the open panel), a tap on the photo, a
  swipe down on the photo, or Escape shuts it. A swipe down on the full-screen
  photo closes the viewer.
- The keys work as in portrait: ArrowUp opens the panel and then scrolls it
  up. ArrowDown scrolls it down, and at the end of the scroll it shuts the
  panel.
- A swipe left or right on the photo goes to the next or the previous photo or
  post, with the panel open or shut.
- The panel has no drag. A touch that starts in the panel starts no swipe, so
  the panel scrolls.

The panel is `clamp(18rem, 38vw, 26rem)` wide and as tall as the screen. It
has one flow: the text, then the map, then the camera data and the comments.
The map is a square, at most 18rem wide.

The viewer keeps one sheet state for both orientations. A rotation changes the
layout with no reload, and an open sheet stays open and a shut sheet stays
shut, in both directions. The side test runs on each rotation event (the
orientation query, `resize`, `orientationchange`, `screen.orientation`), and
again two frames and 300 ms later (`atlasLayerLayout.ts::settledCall`). On iOS
the events can come before the viewport has its new size, so the first read can
give the old orientation. Prev/next and Back/Forward keep the state as in
portrait (`sheetKept`). The map window follows the slot while the panel
slides, and the ocean goes back to `hidden` when the panel shuts. The return
from the full map opens the panel and shrinks the map into its slot.

Portrait, and any device with a mouse or a trackpad, keep the bottom sheet.

## The map in the sheet

A post with its own place tag (a tag with `latitude` and `longitude`, not an
inherited ancestor) shows a map of that place in the Details sheet. The map is
a square, `min(50%, 18rem)` wide, on the right: it is under the camera data
(EXIF) when the post has some, in the same column and at the same width. The
text of the sheet flows on the left. At 480 px and less the map is full width,
at most 16rem high, and after the text (at the top of the sheet it would cover
the close and share buttons). The sheet does not make a second map. It has an empty slot, and the
[`tags-atlas`](tags-atlas.md) map shows through it (`atlasOcean.ts`, the
`window` presentation). The window follows the slot while the sheet drags,
slides and scrolls. Drag and pinch in the slot move the map, not the sheet.

The window shows the place at zoom 10, with its dot, its label and its cloud
with one ring only (`AtlasPlaces.ts::openWindowPlace`, `ringLayout` with
`maxRings: 1`): at most four chips, 66 px from the place. The other rings are
not drawn. A chip that the window edge cuts is not drawn either; at 18rem all
first-ring chips fit. The ring is in px, so the zoom does not change the fit;
zoom 10 keeps the other places far from the ring.

- With `tags-atlas` off, or with no place tag on the post, there is no slot and
  Leaflet does not load.
- There is one map for the visit. A list page builds it when the browser is
  idle (the warm-up, not when the browser asks to save data), and a post sets it
  to `hidden` and keeps it. The window shows that same map, with no new tiles
  and no new places request.
- A post that is the first page of the visit builds the map when the sheet
  opens on it.
- The ocean goes back to `hidden` when the sheet closes and when the viewer
  goes (a close, or a move to the previous or next post).
- A move to the previous or next post keeps the sheet state. The keys, the
  photo panels and the footer links do this. When the sheet is open, it is open
  on the next post with no slide, at the top of its scroll, and the window
  shows the place of the next post. When the next post has no place tag, there
  is no slot and the ocean stays `hidden`. When the sheet is shut, it stays
  shut. Each post's history entry keeps its own state (`sheetKept: true`,
  `atlasFromPost.ts`), so Back and Forward show each post as you left it. The
  key is not `sheet: 'open'`: that key is the return from the full map, which
  shrinks the full map into the slot.

A tap on the map (or on a place or a chip in it) opens the place's tag page in the `map`
state: `/tags/<place>?view=map&at=<lat>,<lng>,6`. It is one motion. The window
grows from the slot to the whole screen and brings the place to the centre,
while the viewer and its header fade (0.28 s). Then the tag page opens on the
same map, the zoom changes to 6, the place is selected, its cloud opens and the
chip of the post you came from is focused. The new history entry has the state
`{ fromPost: <post slug>, fromTitle: <post title>, sheet: 'open' }`, and the
post's own entry gets `{ sheet: 'open' }`. With `prefers-reduced-motion:
reduce` the change is instant. A place that is not on the map (hidden, or out
of the year range) opens the same page, centred on it, with no selection.

The slot is also a keyboard control: `role="button"`, `tabindex="0"` and the
name "Open on the map: <place>". Enter and Space on the focused slot do the
same as a tap. The focus ring is outside the slot edge, so the map above the
slot does not cover it. In window mode the map has `aria-hidden="true"`, so a
screen reader reads the slot name once. The map is also out of the Tab order:
its children are `inert` and the container has `tabindex="-1"`
(`atlasOcean.ts::inertChildren`). Drag, pinch and tap still work on the
container. The full map and the map beside the list are in the Tab order again.

An expand icon (two diagonal arrows, 24 px, on a soft background in the theme's
colours) is in the top-right corner of the window. It tells that a tap opens
the full map. The icon is in the map container, above the map
(`atlasOcean.ts`, `.atlas-window-hint` in `atlas.css`), and it takes no taps: a
tap on it is a tap on the map. It fades out while the window grows into the
full map and fades in again when the window is back on the slot. With
`prefers-reduced-motion: reduce` it does not fade.

The way back is the same motion in reverse. Use the browser Back, or the
"‹ <post title>" chip at the top of the full map. The chip shows only while the
history entry has `fromPost`; a tap on it is `history.back()`. The post opens
with the sheet open (no slide). The map stays on screen over the post until the
map slot has its first layout. Then the map shrinks from the whole screen into
the slot and the place pans back to the slot centre. After the shrink, the zoom
changes back to the slot zoom (10). With `prefers-reduced-motion: reduce` the
change is instant. The cloud that was open on the tag page closes when the map
goes into the window, and the widget's own one-ring cloud opens after the
shrink. A post that the map layer opened keeps its way back to the list: a
close of the post after this round trip still goes to the list URL, and the
list shows the viewport of that URL (`?at=`), not the view of the widget.
