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
inherited ancestor) shows a map of that place in the Details sheet, after the
tags. The sheet does not make a second map. It has an empty slot, and the
[`tags-atlas`](tags-atlas.md) map shows through it (`atlasOcean.ts`, the
`window` presentation). The window follows the slot while the sheet drags,
slides and scrolls. Drag and pinch in the slot move the map, not the sheet.

- With `tags-atlas` off, or with no place tag on the post, there is no slot and
  Leaflet does not load.
- A post that is the first page of the visit builds the map when the sheet
  opens on it.
- The ocean goes back to `hidden` when the sheet closes and when the viewer
  goes (a close, or a move to the previous or next post).

A tap on the map (or on a place in it) opens the place's tag page in the `map`
state: `/tags/<place>?view=map&at=<lat>,<lng>,6`. It is one motion. The window
grows from the slot to the whole screen and brings the place to the centre,
while the viewer and its header fade (0.28 s). Then the tag page opens on the
same map, the zoom changes to 6, the place is selected, its cloud opens and the
chip of the post you came from is focused. The new history entry has the state
`{ fromPost: <post slug>, sheet: 'open' }`. With `prefers-reduced-motion:
reduce` the change is instant. A place that is not on the map (hidden, or out
of the year range) opens the same page, centred on it, with no selection.
