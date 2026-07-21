# Timeline

An interactive horizontal pan/zoom control over year tags (`kind='year'`), shipped as
the `timeline` slot plugin (`frontend/src/plugins/timeline/index.js`, ~1500 lines). Two
modes:

- **Filter mode** (HomePage, map): the centered year/range filters posts/pins live and
  syncs to the URL (`?timeline=2023-2024`, `/map/2024-2026`) through the shared
  ViewContext.
- **Popover mode** (public pages): click a year to see its locations.

## What is implemented

Mechanics: collision clustering, snap-to-center with eased ~320 ms animations,
throttled live filtering, pinch/swipe gestures, decade ticks, momentum, double-click /
double-tap zoom, chevron nav buttons, keyboard navigation.

From the 2026 UX pass (the proposal graduated into implementation):

- **Density histogram** along the axis (height ∝ `post_count` per year) — the timeline
  reads as a picture of the archive; every cluster's histogram tracks the pill above it.
- **Page-scroll safety on touch**: `touch-action: pan-y` on the container — a vertical
  swipe scrolls the page, never zooms the control.
- **Bottom sheet** for the locations popover on mobile (`.bottom-sheet` class) instead
  of a cramped anchored card; the clicked year is always the first row.
- **Haptic tick** on snap (`navigator.vibrate(10)`), respecting reduced motion.
- ≥44 px touch targets on coarse pointers.

## Key decisions (including deliberate divergence from the proposal)

- **Plain mouse-wheel zooms** — the proposal called for Ctrl/Cmd+wheel with wheel
  passthrough, but macOS pinch arrives as a ctrl-modified wheel chord before the
  browser, making plain-wheel the only reliable trigger. Hovering the timeline
  captures the wheel; moving off it restores page scroll. (Documented in the code —
  keep this rationale when touching wheel handling.)
- **Year granularity only** — the data model is year tags; there is no month zoom.
- Popover mode has no center-selection semantics; the center indicator belongs to
  filter mode.

## Not (yet) implemented from the UX proposal

Range readout chip with reset (`2014 – 2024 · 87 posts ×`), honest collapsed
"All years · N posts" state with a one-time gesture hint, hover tooltips with counts,
cluster fan-out transitions, two-finger-tap zoom-out, `aria-live` range announcements.
These remain good candidates; the proposal's mockups live in git history
(`docs/features/timeline-ux-proposal.md`, removed 2026-07).

## Gotchas

- The fold/relayout contract matters: timeline data arrives after first paint, and the
  header/slot system re-runs layout on `relayout()` — don't reintroduce
  attach-once-at-first-render bugs.
- Timeline queries read `YearTags` from the TagGraph snapshot
  (`api/internal/services/timeline_service.go`) — an indexed `kind='year'` filter, not
  a recursive CTE.
