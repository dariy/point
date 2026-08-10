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
