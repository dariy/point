# Immersive — Sheet (`immersive-sheet`)

**Type:** enhancer · **Slot:** `post-viewer` · **Area:** `immersive` (core) · **Default:** disabled · **Title:** Immersive (Sheet)

An alternative post viewer presentation: full-screen photo with a swipe-up details
sheet, rather than the standard carousel's chrome. Shares most viewer code with
[`immersive`](immersive.md) (esbuild code-splitting dedupes the common modules into a
shared chunk).

Exclusive pair with `immersive` in the `Core` `immersive` area — enabling this plugin
disables the standard viewer and vice versa, and at least one of the two must stay
enabled at all times.

See [Immersive Mode & Media Viewer](../features/immersive.md) for details.
