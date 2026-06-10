# Timeline Control — Best-in-Class UX Proposal

UX proposal for the Timeline control on desktop and mobile. Proposal only — no
implementation yet. Tracked under beads issue **point-krcu**.

## Background

The Timeline (`frontend/src/components/public/Timeline.js`,
`frontend/css/public/timeline.css`) is a horizontal pan/zoom control showing
year tags as pills, used in two modes: **popover** (public pages — click a
year, see its locations) and **filter** (HomePage/MapPage — the centered
year/range filters posts/pins live).

The engineering underneath is already strong: collision clustering,
snap-to-center, 320 ms eased animations, throttled live filtering, pinch/swipe
gestures, decade ticks. What keeps it from best-in-class is **UX, not
mechanics**:

1. **It hijacks the page.** `touch-action: none` means a vertical swipe
   starting on the timeline zooms it instead of scrolling the page (mobile's
   #1 sin). On desktop, plain mouse-wheel is captured for zoom, trapping page
   scroll whenever the cursor crosses the control.
2. **It's mute at rest.** The collapsed state is a single mysterious cluster
   pill. Nothing signals "drag me," vertical-drag-zoom is undiscoverable, and
   `post_count` data — already in the API payload — is never visualized.
3. **Selection is implicit.** In filter mode the "current range" is only a
   20 %-opacity center line plus a highlighted pill; there is no readable
   range readout and no obvious way to reset to "all years."
4. **Mobile is desktop-shrunk.** Pills are ~28 px tall (below the 44 px touch
   minimum), and the locations popover is a tiny anchored card instead of a
   thumb-friendly sheet.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Evolve the existing pan/zoom pill-track model | The mechanics are solid; the gaps are affordances, legibility, and platform fit |
| Mobile vertical swipe | Scrolls the **page** (`touch-action: pan-y`); vertical-drag-zoom removed on touch | Never block page scrolling; pinch + double-tap cover zoom |
| Desktop wheel | **Ctrl/Cmd + wheel** zooms; plain wheel passes through to the page | Maps/Figma convention; eliminates the scroll trap |

## Design principles

1. **Informative at rest, navigable on intent.** The control should
   communicate "this is your life over time" before anyone touches it.
2. **Never steal the page.** Scrolling past the timeline must always work;
   timeline gestures must be deliberate.
3. **Every gesture has a visible alternative.** Drag has chevrons; pinch has
   double-tap; zoom has a hint.
4. **One mental model, device-native gestures.** Same pan/zoom/snap semantics
   everywhere; the gestures differ per input device.

## Proposed design

### A. Visual layer (both platforms)

**A1. Density histogram.** Render subtle vertical bars (or a soft area fill)
along the axis, height ∝ `post_count` per year — the data is already in the
`/api/timeline` payload. This is the Google Photos / Flickr scrubber pattern:
the timeline becomes a picture of the archive, clusters stop feeling
arbitrary, and empty years read as intentional gaps. Color: `--border-subtle`
at rest, `--color-primary` at low opacity within the active range.

**A2. Range readout chip (filter mode).** A small persistent chip at the
top-center of the track: `2014 – 2024 · 87 posts`. It updates live during drag
(the throttled emit already exists) and doubles as the **reset control** —
when the range ≠ full extent it gains an `×`; clicking it animates back to the
collapsed "all years" state. This makes the current filter readable, the
filter's existence obvious, and undo one click.

**A3. Honest collapsed state.** Instead of a lone cluster pill, the collapsed
state shows an **"All years · N posts"** pill plus the density histogram
across the full extent. First interaction per browser (localStorage flag)
shows a one-time ghost hint under the track: *"Drag to explore · pinch or
Ctrl+scroll to zoom."*

**A4. Edge affordances.** Keep the gradient fade masks; **re-enable the
chevron nav buttons** that are already implemented but commented out
(`Timeline.js` render(), `_updateNavButtons` logic exists). Desktop: fade in
on container hover when content overflows. Mobile: always visible when
overflowing (smaller, 28 px).

**A5. Stronger center indicator (filter mode only).** Replace the
20 %-opacity full-height line with a short caret/notch at the axis plus the
readout chip. In popover mode (no center semantics), hide the indicator
entirely — today it implies a selection that doesn't exist.

**A6. Cluster fan-out.** When a cluster expands (zoom-to-fit), pills animate
outward from the cluster's position rather than re-rendering in place — the
existing `_animateTo` easing covers the pan/zoom, but pills should transition
`left` (`transition: left 200ms` during programmatic zoom only, never during
drag).

### B. Desktop interactions

| Input | Action |
|---|---|
| Drag track | Pan (kept), add momentum flick |
| **Ctrl/Cmd + wheel** | Zoom around cursor |
| Plain wheel | **Passes through to page scroll**; transient hint "Use ⌘/Ctrl + scroll to zoom" appears (Google Maps pattern, ~1.5 s fade) |
| Shift + wheel / trackpad horizontal | Pan |
| Vertical mouse drag | Zoom (kept — now a bonus path, not the only one) |
| Double-click track | Zoom in ~2× around point; Alt + double-click zooms out |
| Hover axis | Year tooltip under cursor (`2019`) |
| Hover pill | Tooltip `2019 · 12 posts` (counts are currently invisible until popover opens) |
| Click readout chip `×` | Reset to all years |

**Keyboard (track is one tab stop):** `←`/`→` move focus between
pills/clusters and auto-scroll (exists); `+`/`-` zoom around center;
`Home`/`End` jump to extents; `Enter`/`Space` activate focused pill; `Esc`
closes popover (exists), second `Esc` resets zoom. An `aria-live="polite"`
region announces range changes ("Showing 2014 to 2024, 87 posts") and pill
focus ("2019, 12 posts").

### C. Mobile interactions

| Input | Action |
|---|---|
| Vertical swipe | **Scrolls the page** (`touch-action: pan-y`; remove the `stopPropagation` + vertical-zoom path for touch) |
| Horizontal swipe | Pan with momentum, then snap-to-center (snap exists) |
| Pinch | Zoom (kept) |
| Double-tap | Zoom in around tap point |
| Two-finger tap | Zoom out (Maps convention) |
| Tap pill | Same as click |

- **Touch targets:** pills get invisible hit-slop to ≥ 44 px (pseudo-element
  or padding on the wrapper, visual size unchanged); track height 56 → 64 px
  on coarse pointers (`@media (pointer: coarse)`).
- **Locations popover → bottom sheet** on viewports < 640 px: slides up from
  the bottom, larger rows, swipe-down or scrim-tap to dismiss. Anchored
  popovers near the top edge on a phone are cramped and finger-occluded; this
  is the standard mobile resolution. The clicked year remains the first row
  (existing rule — keep).
- **Haptic tick** on snap-to-center where supported (`navigator.vibrate(10)`),
  respecting reduced-motion.

### D. Mode-specific notes

- **Filter mode (Home/Map):** live readout chip (A2) + reset; URL sync
  (`?timeline=`, `/map/2024-2026`) already works — unchanged.
- **Popover mode:** add `role="dialog"`, focus moves into popover on open and
  returns to the pill on close, arrow keys traverse the location list. Keep
  the "clicked year is always the first navigable item" rule.
- **Reduced motion:** extend the existing `prefers-reduced-motion` block to
  skip momentum, fan-out, sheet slide, and haptics.

## Mockups

### Desktop — filter mode, mid-zoom

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         ┌──────────────────────┐                         │
│  ‹                      │ 2014 – 2024 · 87  ✕  │                      ›  │
│                         └──────────────────────┘                         │
│   ▂▃▂  ▅▂▃▁▂▃▆▂▃▅▇▅▃▂▁▂▃▅▂▁▃▂▅▃▂▃▁  ← density histogram                  │
│  (2009–2012) (2013) (2014)  ▾  [2019]  (2020) (2021–2022) (2024)         │
│ ──┴───────────┴────────┴────────┴────────┴──────────┴─────────┴──        │
│  2010                 center caret ▴ + active pill   2020                │
└──────────────────────────────────────────────────────────────────────────┘
   hover: ░ 2017 · 9 posts ░        plain scroll → "Use ⌘+scroll to zoom"
```

### Desktop — collapsed (at rest)

```
┌──────────────────────────────────────────────────────────────────────────┐
│        ▁▂▃▂▅▂▃▁▂▃▆▂▃▅▇▅▃▂▁▂▃▅▂▁▃▂▅▃▂▃▁▂▃▂▁▂▃▂▅▃▂                         │
│                      ( All years · 312 posts )                           │
│ ──┬──────────┬──────────┬──────────┬──                                   │
│  1990       2000       2010       2020                                   │
│         "Drag to explore · pinch or Ctrl+scroll to zoom"  (first visit)  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Mobile — popover mode with bottom sheet

```
┌────────────────────────────┐      ┌────────────────────────────┐
│  ▂▃▅▇▅▃▂▁▂▃▅▂▁▃▂▅▃         │      │ ░░░░░ page dimmed ░░░░░░░  │
│ ‹ (2013–2015) [2019] (2021)│  tap │ ┌────────────────────────┐ │
│ ──┴──────┴──────┴────── ›  │ 2019 │ │        ────            │ │
│   vertical swipe = page    │ ───► │ │  2019          12 ●    │ │
│   scroll; pinch = zoom     │      │ │  ──────────────────    │ │
└────────────────────────────┘      │ │  Lisbon          5     │ │
                                    │ │  Kyiv            4     │ │
                                    │ │  Batumi          3     │ │
                                    │ └── swipe down to close ─┘ │
                                    └────────────────────────────┘
```

## Prioritized roadmap

**P0 — stop harming (small, high-impact fixes)**

1. `touch-action: pan-y`; remove touch vertical-zoom + `stopPropagation` on
   touchstart/touchmove
2. Ctrl/Cmd+wheel zoom; plain wheel passes through + transient hint
3. Re-enable chevron nav buttons (code exists, commented out)
4. ≥ 44 px touch targets + 64 px track on coarse pointers

**P1 — make it legible**

5. Range readout chip + reset (filter mode)
6. Density histogram from `post_count`
7. Honest collapsed state + one-time gesture hint
8. Hover tooltips (year under cursor, pill counts)
9. Hide center indicator in popover mode; caret style in filter mode

**P2 — make it delightful**

10. Bottom sheet for mobile popovers
11. Momentum panning, double-tap / double-click zoom, two-finger-tap zoom out
12. Cluster fan-out transition
13. Keyboard zoom (`+`/`-`, `Home`/`End`) + `aria-live` announcements +
    popover focus management
14. Haptic snap tick

## Considered and rejected

- **Brush/range handles** (finance-chart pattern): heavier UI for marginal
  gain since center-snap + cluster tap already select ranges.
- **Month-level zoom**: the data model is year tags only.
