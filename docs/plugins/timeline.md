# Timeline (`timeline`)

**Type:** slot · **Slot:** `timeline` · **Default:** enabled

An interactive horizontal pan/zoom control over year tags (`kind='year'`)
(`frontend/src/plugins/timeline/index.js`, ~1500 lines). Two modes: **filter mode**
(home page, map) where the centered year/range filters posts/pins live and syncs to
the URL; **popover mode** (public post/tag pages) where clicking a year shows its
locations.

Mechanics include collision clustering, snap-to-center animations, a density histogram
per year (height proportional to post count), pinch/swipe gestures, decade ticks,
momentum, double-click/double-tap zoom, and full keyboard navigation. Disabling the
plugin removes the control from every page that would otherwise host it.

See [Timeline](../features/timeline.md) for the full mechanics writeup, including
deliberate divergences from the original design proposal.
