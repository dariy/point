# Immersive — Standard (`immersive`)

**Type:** enhancer · **Slot:** `post-viewer` (cardinality `1`) · **Default:** enabled · **Title:** Immersive (Standard)

The standard full-screen media viewer/carousel for posts: keyboard navigation
(arrows/Home/End/PageUp/PageDown), swipe gesture handling, pinch-to-zoom and
drag-to-pan on touch, slide indicators, chrome auto-hide, cross-post navigation
(advancing past the last slide routes to the next post), and a per-slide URL hash.

One of the two candidates for the `post-viewer` slot, together with
[`immersive-sheet`](immersive-sheet.md). The slot's cardinality is `1`, so exactly
one viewer is active: the Plugins page shows the active one read-only ("In use") and
you switch by enabling the alternative, which flips this one off in the same call.
The tag visualizations work the same way on `tags-route`; that slot just also allows
"none".

See [Immersive Mode & Media Viewer](../features/immersive.md) for the full plugin
family, including [`immersive-share`](immersive-share.md) and
[`slideshow`](slideshow.md).
