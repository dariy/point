# Edge Rubber-Band Swipe Animation — Design

**Date**: 2026-03-06
**Status**: Approved

## Problem

When swiping toward a navigation boundary (no previous/next post, first/last page), the drag is silently blocked — the content doesn't move at all. This breaks the gesture continuity and feels unresponsive.

## Goal

Allow dragging in any direction at all times. When a direction is blocked (no target), apply a resistance curve so the content moves but fights back. On touch end, spring back to rest.

## Approach: Shared `rubberBand()` utility

A single damping function exported from `gestures.js`, applied at each swipe consumer. Spring-back reuses existing `onSwipeCancel` CSS transition logic — no new animation machinery needed.

### Damping formula

iOS-style rubber-band curve:

```
rubberBand(dx, width) = sign(dx) × (1 - 1 / (|dx| × 0.55 / width + 1)) × width
```

Behaviour:
- 0px input → 0px output (no movement at rest)
- 50px → ~38px (76%)
- 100px → ~64px (64%)
- 200px → ~96px (48%)
- Asymptotes at ~`width` — content can never be dragged off-screen

### Touch feedback (opacity)

When in rubber-band mode, opacity stays near 1 (range 0.85–1.0) — fading is only meaningful when navigating, not bouncing.

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/utils/gestures.js` | Export `rubberBand(dx, width)` |
| `frontend/src/components/public/PostContent.js` | `_initNormal`: replace two `return` guards with damped `translateX`; `_initImmersive`: detect blocked direction before `_updateVisuals`, pass damped `dx` |
| `frontend/src/pages/public/HomePage.js` | Replace two `return` guards with damped `translateX` on `gridMount` |
| `frontend/src/pages/public/TagPage.js` | Same as `HomePage` |

## Spring-back

All existing `onSwipeCancel` handlers already animate back to `transform: ''` with `transition: transform 0.3s ease, opacity 0.3s ease`. This covers spring-back for free — no extra code required.

`onSwipeCommit` in a blocked direction also triggers the same spring-back (already handled as an `else` branch in all consumers).

## Immersive Carousel Edge Detection

In `_initImmersive`, the direction convention is reversed:
- `dx < 0` (left swipe) → `goTo(index + 1)` → exits to `prevPost` when at last slide
- `dx > 0` (right swipe) → `goTo(index - 1)` → exits to `nextPost` when at first slide

Blocked conditions:
- `dx < 0` blocked when: at last slide (`index === slides.length - 1` or no slides) **and** no `prevPost`
- `dx > 0` blocked when: at first slide (`index === 0` or no slides) **and** no `nextPost`

When blocked, pass `rubberBand(dx, window.innerWidth)` to `_updateVisuals` instead of `dx`.

## Non-goals

- No visual "edge indicator" (glow, tint) — movement feedback is sufficient
- No trackpad rubber-band (trackpad swipes are discrete navigation events, not continuous drags)
- No change to pinch/zoom or vertical swipe behaviour
