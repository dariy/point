# Gesture System Rework — Design

**Date:** 2026-03-06
**Status:** Approved
**Scope:** Frontend gesture system + backend post-page-location endpoint

---

## Goals

1. Replace basic `SwipeDetector` with a professional-grade unified `GestureController`
2. Add pinch-to-zoom for images in immersive mode (bounds: fit-to-screen ↔ 1:1 pixel scale)
3. Swipe-down in immersive mode opens the containing list (tag page or home page at correct page number)
4. Reverse horizontal navigation direction: swipe-left → older posts, swipe-right → newer posts
5. Extract post visibility logic into a reusable shared helper (no more inline duplication)

---

## Architecture Overview

```
gestures.js (full rewrite)
  └── GestureController          ← replaces SwipeDetector
        State machine: IDLE → SINGLE_TOUCH → SWIPING_H | SWIPING_V | PINCHING | PANNING
        Callbacks: onSwipeMove, onSwipeCommit, onSwipeCancel,
                   onPanMove, onPinchMove, onPinchEnd, onTap, onDoubleTap
  └── TrackpadDetector           ← kept, direction sign flipped

PostContent.js (updated)
  └── _initImmersive             ← uses GestureController, manages zoom state
  └── _initNormal                ← direction fix only

backend
  └── api/internal/api/visibility.go   ← new: IsPostVisibleToPublic helper
  └── api/internal/api/posts.go        ← new: GetPostPage handler
  └── api/internal/repository/extended.go ← new: ListPublishedPostsWithTagsBefore
  └── api/cmd/api/main.go              ← register GET /api/posts/:slug/page
```

---

## Section 1: GestureController State Machine

### States

```
IDLE
 │ touchstart (1 finger)
 ▼
SINGLE_TOUCH ──── touchstart (2nd finger) ──► MULTI_TOUCH
 │                                                │
 │ move > commitThreshold horizontally            │ pinch distance changes
 │   AND not zoomed                               ▼
 ▼                                            PINCHING
SWIPING_H
 │
 │ move > commitThreshold vertically (or zoomed + horizontal)
 ▼
SWIPING_V  /  PANNING

All states ──► touchend / cancel ──► IDLE
```

### Transition Rules

| Condition | Result |
|---|---|
| `touches.length === 2` from any state | Immediately commit to `PINCHING`, cancel pending swipe |
| Zoomed (`scale > 1`) + horizontal drag | Commit to `PANNING`, not `SWIPING_H` |
| Zoomed + swipe commit fires | Navigation blocked by caller checking `controller.isZoomed()` |
| Second tap within 300ms | Fire `onDoubleTap`, suppress `onTap` |
| Lift with total move < 8px | Fire `onTap` |

### Callback Interface

```js
new GestureController(element, {
  onSwipeMove(dx, dy),         // real-time during single-touch drag (visual feedback)
  onSwipeCommit(dir),          // 'left' | 'right' | 'up' | 'down' — threshold crossed
  onSwipeCancel(),             // lifted without committing — reset visuals
  onPanMove(dx, dy),           // real-time pan while zoomed
  onPinchMove(scale, cx, cy),  // multiplicative scale delta + pinch center
  onPinchEnd(),                // fingers lifted after pinch
  onTap(x, y),
  onDoubleTap(x, y),
  // options:
  swipeThresholdPx: 50,
  edgeIgnorePx: 30,            // ignore swipes starting in system back-gesture zones
  doubleTapMs: 300,
  tapMovePx: 8,
})
```

`TrackpadDetector` is kept unchanged except the direction sign is flipped (one-line fix).

---

## Section 2: Pinch-to-Zoom (Immersive Mode)

### Zoom Bounds

```js
// Computed once after image loads (natural size known)
const cssContainFactor = Math.min(
  container.clientWidth  / img.naturalWidth,
  container.clientHeight / img.naturalHeight
);
const pixelScale = 1 / cssContainFactor; // zoom level for 1 CSS px = 1 image px
// Zoom range: [1.0 (fit), pixelScale (1:1 pixel)]
// If pixelScale <= 1.0, image is smaller than screen — zoom disabled entirely
```

### Zoom State (lives in `_initImmersive`)

```js
let currentScale = 1.0;
let panX = 0, panY = 0;
// isZoomed = currentScale > 1.0
```

### Applying Transform

```js
img.style.transformOrigin = `${cx}px ${cy}px`; // pinch center
img.style.transform = `scale(${currentScale}) translate(${panX}px, ${panY}px)`;
```

Pan clamping:
```js
const maxPanX = (img.offsetWidth  * (currentScale - 1)) / 2;
const maxPanY = (img.offsetHeight * (currentScale - 1)) / 2;
panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
```

### Gesture Behaviours

| Gesture | At scale === 1 (fit) | At scale > 1 (zoomed) |
|---|---|---|
| Horizontal swipe | Navigate (prev/next) | Pan image |
| Vertical swipe up | Nothing | Pan image |
| Vertical swipe down | Dismiss to list | Pan image |
| Pinch out | Zoom in (up to pixelScale) | Zoom in further |
| Pinch in | No-op (already at min) | Zoom out |
| Pinch in to min | — | Reset to scale=1, pan=0 |
| Double-tap | Zoom to pixelScale, centered on tap | Reset to scale=1, pan=0 |

### CSS Additions (`immersive.css`)

```css
.immersive-bg-image {
  transform-origin: center center;
  will-change: transform;
  transition: transform 0.25s ease, opacity 0.3s ease;
}
.immersive-bg-image.gesture-active {
  transition: none; /* no easing while finger is moving */
}
.immersive-wrapper[data-zoomed="true"] { cursor: grab; }
.immersive-wrapper[data-zoomed="true"]:active { cursor: grabbing; }
```

---

## Section 3: Direction Reversal

The "virtual movement" convention changes to: swipe-right = move forward in time (newer), swipe-left = move back in time (older).

| Location | Current | New |
|---|---|---|
| `_initImmersive` swipe | `dir === 'left' ? +1 : -1` | `dir === 'left' ? -1 : +1` |
| `_initImmersive` trackpad | `dir === 'left' ? +1 : -1` | `dir === 'left' ? -1 : +1` |
| `_initNormal` swipe | `left→nextPost, right→prevPost` | `left→prevPost, right→nextPost` |
| `_initNormal` trackpad | same | same fix |

---

## Section 4: Swipe-Down → List Navigation

### With tag context (`tagSlug` present)
```js
navigate(`/tag/${tagSlug}`);
```

### Without tag context (standalone post page)
```js
const dismiss = async () => {
  try {
    const { page } = await fetch(`/api/posts/${post.slug}/page`).then(r => r.json());
    navigate(`/?page=${page}`);
  } catch {
    navigate('/');
  }
};
```

Visual feedback during swipe-down (already implemented — keep): scale-shrink + fade as finger drags down.

---

## Section 5: Backend — Visibility Layer + Endpoint

### Shared Helper (new file)

**`api/internal/api/visibility.go`**

```go
// IsPostVisibleToPublic returns true if none of the post's tags
// are in the effectively-hidden-posts set.
func IsPostVisibleToPublic(postTags []repository.TagWithVisibility, hiddenPostsTagIDs map[int64]bool) bool {
    for _, t := range postTags {
        if hiddenPostsTagIDs[t.ID] {
            return false
        }
    }
    return true
}
```

Existing inline loops in `GetHomePage` and `GetTagPage` are refactored to use this function.

### New Endpoint

**Route:** `GET /api/posts/:slug/page` (public, no auth required)

**Response:**
```json
{ "page": 2, "per_page": 20 }
```

**Handler logic (`api/internal/api/posts.go`):**
```
1. tagService.EffectivelyHiddenPostsTagIDs() → hiddenMap
2. repo.GetPostBySlug(slug) → targetPost
3. repo.ListPublishedPostIDsWithTags() → all published posts (lightweight: id, published_at, tags only)
4. Filter with IsPostVisibleToPublic(post.tags, hiddenMap)
5. Find position of targetPost.slug in filtered list (sorted by published_at DESC)
6. perPage from settings (default 10)
7. return {"page": ceil(position / perPage), "per_page": perPage}
```

**New repository method (`extended.go`):**
```go
// ListPublishedPostIDsWithTags returns id + published_at for all published,
// non-hidden posts, sorted newest-first. Lightweight — no content fields.
func (r *Repository) ListPublishedPostIDsWithTags(ctx context.Context) ([]PostStub, error)

type PostStub struct {
    ID          int64
    Slug        string
    PublishedAt time.Time
    Tags        []TagStub
}
```

---

## File Change Summary

| File | Type | Change |
|---|---|---|
| `frontend/src/utils/gestures.js` | Rewrite | `GestureController` class + keep `TrackpadDetector` |
| `frontend/src/components/public/PostContent.js` | Update | Use `GestureController`, zoom state, direction fix, new `dismiss` |
| `frontend/css/public/immersive.css` | Update | Zoom cursor states, `will-change`, `.gesture-active` |
| `api/internal/api/visibility.go` | New | `IsPostVisibleToPublic` helper |
| `api/internal/api/pages.go` | Refactor | Use `IsPostVisibleToPublic` instead of inline loops |
| `api/internal/api/posts.go` | Update | Add `GetPostPage` handler |
| `api/internal/repository/extended.go` | Update | Add `ListPublishedPostIDsWithTags` |
| `api/cmd/api/main.go` | Update | Register `GET /api/posts/:slug/page` |
