# Immersive — Standard (`immersive`)

**Type:** enhancer · **Slot:** `post-viewer` · **Area:** `immersive` (core) · **Default:** enabled · **Title:** Immersive (Standard)

The standard full-screen media viewer/carousel for posts: keyboard navigation
(arrows/Home/End/PageUp/PageDown), swipe gesture handling, pinch-to-zoom and
drag-to-pan on touch, slide indicators, chrome auto-hide, cross-post navigation
(advancing past the last slide routes to the next post), and a per-slide URL hash.

Shares the `immersive` area with [`immersive-sheet`](immersive-sheet.md) as an
exclusive pair for the `post-viewer` slot — exactly one is the active viewer at a
time. The area is also `Core`, so at least one of the pair must always stay enabled;
the last enabled member cannot be disabled from the Plugins page.

See [Immersive Mode & Media Viewer](../features/immersive.md) for the full plugin
family, including [`immersive-share`](immersive-share.md) and
[`slideshow`](slideshow.md).
