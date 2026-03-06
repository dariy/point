# Gesture Navigation — Design Document

> **Date**: 2026-03-05
> **Status**: Approved
> **Scope**: Frontend only — no backend changes

---

## 1. Overview & Motivation

Point's public interface is heavily used on mobile. Currently, navigation between posts and grid pages relies entirely on tapping explicit links (arrows, pagination buttons). This creates friction in immersive reading contexts where users expect to swipe between items.

Goals:
- Make the immersive post viewer feel native on mobile (swipe left/right between posts, swipe down to dismiss)
- Add page-flip swipe to the post grid (home and tag pages)
- Extend the same horizontal navigation to desktop trackpads via wheel event detection
- Preserve all existing keyboard navigation without regression

---

## 2. Platform Constraints

### Mobile touch

- **iOS Safari back gesture**: A left-edge swipe (starting within ~30 px of the screen left edge) triggers the browser's native back navigation. Any horizontal swipe detector must ignore swipes originating in that zone to avoid conflicts.
- **Android back gesture**: Android 10+ uses a right-edge swipe for system back. Same 30 px exclusion zone applies on the right edge.
- **Passive listeners**: All touch listeners must be registered as `{ passive: true }` so the browser can optimise scroll performance. This means `preventDefault()` cannot be called; navigation is triggered only after the gesture completes (on `touchend`).
- **Axis locking**: Only fire when the gesture has a clear dominant axis (horizontal or vertical). Diagonal swipes are ignored.

### Desktop trackpad

- **Wheel events**: Trackpad horizontal swipes generate `wheel` events with a large `deltaX` and near-zero `deltaY`. Mouse scroll wheels generate `deltaY` only. Detecting `abs(deltaX) > threshold && abs(deltaY) < maxDeltaY` reliably discriminates intentional trackpad swipes.
- **Momentum scrolling**: Trackpad inertia can produce a burst of wheel events after a single swipe. A cooldown (600 ms after the first qualifying event) prevents chaining multiple navigations from one gesture.

### Edge protection

All swipe detectors apply a 30 px edge-ignore zone on both the left and right sides of the viewport. Swipes whose `touchstart` falls inside either zone are silently discarded.

---

## 3. Gesture Taxonomy

| Surface | Gesture | Action |
|---|---|---|
| Immersive (carousel) | swipe left | next image (or next post at boundary) |
| Immersive (carousel) | swipe right | prev image (or prev post at boundary) |
| Immersive (any) | swipe down | dismiss — return to grid context |
| Immersive (trackpad) | swipe left | same as touch left |
| Immersive (trackpad) | swipe right | same as touch right |
| Normal post view | swipe left | navigate to next post |
| Normal post view | swipe right | navigate to prev post |
| Normal post view (trackpad) | swipe left | navigate to next post |
| Normal post view (trackpad) | swipe right | navigate to prev post |
| Home grid (multi-page) | swipe left | next page |
| Home grid (multi-page) | swipe right | prev page |
| Home grid (trackpad) | swipe left/right | same |
| Tag grid (multi-page) | swipe left | next page |
| Tag grid (multi-page) | swipe right | prev page |
| Tag grid (trackpad) | swipe left/right | same |

All gestures navigate immediately with no slide animation.

---

## 4. Shared Gesture Utility API

New file: `frontend/src/utils/gestures.js`

### SwipeDetector

Wraps `touchstart` / `touchend` on a given element.

```
new SwipeDetector(element, options)

options:
  onHorizontal(dir: 'left' | 'right')   — called on a qualifying horizontal swipe
  onVertical(dir: 'up' | 'down')         — called on a qualifying vertical swipe
  thresholdPx   = 50                     — minimum travel distance
  edgeIgnorePx  = 30                     — ignore-zone width at each screen edge

instance.destroy()   — removes all listeners
```

Decision logic (evaluated on `touchend`):
1. Compute `dx = endX - startX`, `dy = endY - startY`.
2. If `startX < edgeIgnorePx` or `startX > innerWidth - edgeIgnorePx` → discard.
3. If `abs(dx) > abs(dy)` and `abs(dx) > threshold` → `onHorizontal(dx < 0 ? 'left' : 'right')`.
4. If `abs(dy) > abs(dx)` and `abs(dy) > threshold` → `onVertical(dy < 0 ? 'up' : 'down')`.

All listeners registered as `{ passive: true }`.

### TrackpadDetector

Wraps `wheel` events on a given element.

```
new TrackpadDetector(element, options)

options:
  onHorizontal(dir: 'left' | 'right')
  thresholdDeltaX = 60     — minimum abs(deltaX) to qualify
  maxDeltaY       = 30     — maximum abs(deltaY) allowed (keeps mouse scroll out)
  cooldownMs      = 600    — minimum ms between fired events

instance.destroy()   — removes all listeners
```

Direction mapping: `deltaX > 0` → `'left'`; `deltaX < 0` → `'right'`.

Listener registered as `{ passive: true }`.

---

## 5. Surface-by-Surface Behavior

### Immersive mode (`PostContent._initImmersive`)

The existing inline `touchstart`/`touchend` block is replaced with a `SwipeDetector`:
- `onHorizontal`: existing `goTo(index ± 1)` logic (with boundary wrapping to prev/next post)
- `onVertical('down')`: dismiss — navigates to `/tag/${tagSlug}` if a tag context exists, otherwise calls `history.back()`

A `TrackpadDetector` is added with the same horizontal callback.

Both detectors are stored on the component instance and destroyed in `beforeUnmount()`.

### Normal post view (`PostContent._initNormal`)

A new `_initNormal(prevPost, nextPost)` method, called from `afterRender()` when not in immersive mode and at least one neighbour post exists.

`SwipeDetector` on `this.container`:
- `onHorizontal('left')` → `nextPost && navigate('/post/' + nextPost.slug)`
- `onHorizontal('right')` → `prevPost && navigate('/post/' + prevPost.slug)`

`TrackpadDetector` with the same callbacks.

Both stored and destroyed alongside existing listeners.

### Home grid (`HomePage`)

After mounting `PostGrid`, when `pagination.pages > 1`, attach:
- `SwipeDetector` and `TrackpadDetector` on `this.container`
- `onHorizontal('left')`: navigate to `?page=${page + 1}` if not on last page
- `onHorizontal('right')`: navigate to `?page=${page - 1}` if not on first page

`beforeUnmount()` added to `HomePage` to destroy both detectors.

No detectors are created when `pagination.pages === 1` (single-page grids).

### Tag grid (`TagPage`)

Same pattern as HomePage, applied in the `else` (grid) branch of `afterRender()`.
URLs use `/tag/${slug}?page=N`.

`beforeUnmount()` added to `TagPage`.

---

## 6. Non-Goals

- **No slide animations** — navigation is immediate. Adding transitions is a separate concern.
- **MediaLightbox** — the admin lightbox component is out of scope. The public-facing immersive viewer is handled above.
- **TagsPage tree** — the hierarchical tag browser has no gesture needs identified.
- **Vertical grid scroll** — the page scroll on grid pages is left entirely to the browser; no vertical swipe interception.
- **Pinch-to-zoom** — not addressed.
- **Custom scroll physics** — not addressed.
