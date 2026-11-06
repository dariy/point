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
