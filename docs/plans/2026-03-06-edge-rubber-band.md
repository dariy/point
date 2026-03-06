# Edge Rubber-Band Swipe Animation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When swiping toward a navigation boundary (no prev/next), content still drags with iOS-style resistance and springs back on release instead of silently blocking the gesture.

**Architecture:** Export a `rubberBand(dx, width)` utility from `gestures.js`. Each of the four swipe consumers replaces its early-return boundary guard with a damped `translateX` using this function. Spring-back reuses existing `onSwipeCancel` CSS transition — no new animation machinery.

**Tech Stack:** Vanilla JS, CSS transitions, existing `GestureController`

---

### Task 1: Add `rubberBand` utility to `gestures.js`

**Files:**
- Modify: `frontend/src/utils/gestures.js` (add export before `GestureController` class)

**Step 1: Add the function**

Insert this export at the top of `gestures.js`, before the `STATE` constant:

```js
/**
 * iOS-style rubber-band damping for edge-resistance drag.
 * Returns a damped displacement that fights back as dx grows.
 * @param {number} dx      - Raw displacement in px (positive or negative)
 * @param {number} width   - Viewport/container width in px (default: window.innerWidth)
 * @returns {number} damped displacement
 */
export function rubberBand(dx, width = window.innerWidth) {
  const absDx = Math.abs(dx);
  const damped = (1 - 1 / (absDx * 0.55 / width + 1)) * width;
  return dx < 0 ? -damped : damped;
}
```

**Step 2: Verify no breakage**

Open the app in the browser and swipe normally — existing navigation should be unaffected (the function is not called yet).

---

### Task 2: Apply rubber-band in `_initNormal` (PostContent)

**Files:**
- Modify: `frontend/src/components/public/PostContent.js:476-503`

**Context:** `_initNormal` currently blocks drag at boundaries with `return`. Replace with damped drag.

**Step 1: Import `rubberBand`**

The import at the top of `PostContent.js` currently reads:
```js
import { GestureController, TrackpadDetector } from '../../utils/gestures.js';
```
Change to:
```js
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';
```

**Step 2: Replace the `onSwipeMove` guard in `_initNormal`**

Current code (lines ~479-486):
```js
onSwipeMove: (dx, dy) => {
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0 && !prevPost) return; // swipe-left -> older (prev)
    if (dx > 0 && !nextPost) return; // swipe-right -> newer (next)
    this.container.style.transform = `translateX(${dx}px)`;
    this.container.style.transition = 'none';
    this.container.style.opacity = Math.max(0.3, 1 - Math.abs(dx) / (window.innerWidth || 500));
  }
},
```

Replace with:
```js
onSwipeMove: (dx, dy) => {
  if (Math.abs(dx) > Math.abs(dy)) {
    const blocked = (dx < 0 && !prevPost) || (dx > 0 && !nextPost);
    const tx = blocked ? rubberBand(dx) : dx;
    this.container.style.transform = `translateX(${tx}px)`;
    this.container.style.transition = 'none';
    this.container.style.opacity = blocked
      ? Math.max(0.85, 1 - Math.abs(tx) / (window.innerWidth || 500))
      : Math.max(0.3, 1 - Math.abs(tx) / (window.innerWidth || 500));
  }
},
```

**Step 3: Verify manually**

Navigate to a post that has no previous post. Swipe right — content should drag with resistance and spring back. Swipe left (toward an existing next post) — should behave normally.

---

### Task 3: Apply rubber-band in `_initImmersive` (carousel)

**Files:**
- Modify: `frontend/src/components/public/PostContent.js` — the `onSwipeMove` inside `_initImmersive`

**Context:** Direction convention in the carousel is reversed vs normal view:
- `dx < 0` (left swipe) → `goTo(index + 1)` → exits carousel to `prevPost`
- `dx > 0` (right swipe) → `goTo(index - 1)` → exits carousel to `nextPost`

A direction is "blocked" only when the swipe would leave the carousel AND there's no target post. Within a multi-slide carousel the slides loop — rubber-band only applies at the inter-post boundary.

**Step 1: Replace `onSwipeMove` in `_initImmersive`**

Current code (inside `_initImmersive`):
```js
onSwipeMove: (dx, dy) => this._updateVisuals(dx, dy),
```

Replace with:
```js
onSwipeMove: (dx, dy) => {
  if (Math.abs(dx) > Math.abs(dy)) {
    const n = slides.length;
    const atLastSlide  = n === 0 || index === n - 1;
    const atFirstSlide = n === 0 || index === 0;
    const blockedLeft  = dx < 0 && atLastSlide  && !prevPost;
    const blockedRight = dx > 0 && atFirstSlide && !nextPost;
    const blocked = blockedLeft || blockedRight;
    const tx = blocked ? rubberBand(dx) : dx;
    this._updateVisuals(tx, dy);
  } else {
    this._updateVisuals(dx, dy);
  }
},
```

**Step 2: Verify manually**

Open an immersive/single-image post with no neighbours. Swipe left and right — both directions should rubber-band. On a post with neighbours, swipe toward the existing neighbour — normal navigation, no resistance.

---

### Task 4: Apply rubber-band in `HomePage`

**Files:**
- Modify: `frontend/src/pages/public/HomePage.js:89-165` — `onSwipeMove` inside the gesture setup

**Context:** `HomePage` uses `pagination.page` / `pagination.pages` for boundary detection.

**Step 1: Import `rubberBand`**

Change:
```js
import { GestureController, TrackpadDetector } from '../../utils/gestures.js';
```
To:
```js
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';
```

**Step 2: Replace the boundary guards in `onSwipeMove`**

Current code:
```js
onSwipeMove: (dx, dy) => {
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0 && pagination.page >= pagination.pages) return;
    if (dx > 0 && pagination.page <= 1) return;
    gridMount.style.transform = `translateX(${dx}px)`;
    gridMount.style.transition = 'none';
    gridMount.style.opacity = Math.max(0.2, 1 - Math.abs(dx) / (window.innerWidth || 500));
    // ... previewEl logic ...
  }
},
```

Replace the guards + translateX line (leave the previewEl block untouched):
```js
onSwipeMove: (dx, dy) => {
  if (Math.abs(dx) > Math.abs(dy)) {
    const blocked = (dx < 0 && pagination.page >= pagination.pages)
                 || (dx > 0 && pagination.page <= 1);
    const tx = blocked ? rubberBand(dx) : dx;
    gridMount.style.transform = `translateX(${tx}px)`;
    gridMount.style.transition = 'none';
    gridMount.style.opacity = blocked
      ? Math.max(0.85, 1 - Math.abs(tx) / (window.innerWidth || 500))
      : Math.max(0.2, 1 - Math.abs(tx) / (window.innerWidth || 500));

    if (!blocked) {
      // ... existing previewEl logic unchanged ...
    }
  }
},
```

**Step 3: Verify manually**

Navigate to the home page on the last page. Swipe left (no next page) — rubber-band drag then spring-back. Swipe right (has previous page) — normal navigation.

---

### Task 5: Apply rubber-band in `TagPage`

**Files:**
- Modify: `frontend/src/pages/public/TagPage.js` — same pattern as `HomePage`

**Step 1: Import `rubberBand`**

Change:
```js
import { GestureController, TrackpadDetector } from '../../utils/gestures.js';
```
To:
```js
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';
```

**Step 2: Apply the same replacement pattern as Task 4**

Same structure: `blocked` flag, `tx = blocked ? rubberBand(dx) : dx`, guard `previewEl` creation with `if (!blocked)`.

**Step 3: Verify manually**

Navigate to a tag page on the last page. Swipe toward the edge — rubber-band, spring-back. Swipe the other way — normal navigation.

---

### Task 6: Manual cross-device review

**Checklist:**
- [ ] PostContent normal view — blocked direction rubber-bands, open direction navigates
- [ ] PostContent immersive — single-image at series end rubber-bands both ways; multi-slide navigates normally within slides
- [ ] HomePage — last page left-swipe rubber-bands; first page right-swipe rubber-bands
- [ ] TagPage — same as HomePage
- [ ] All existing `onSwipeCancel` spring-backs still smooth (transition 0.3s ease)
- [ ] No opacity flash or jump at the moment resistance kicks in
- [ ] Swipe threshold still commits navigation when a direction IS open

---

## Notes

- `rubberBand` with `width = window.innerWidth` means ~38px movement for a 50px drag — feels natural on all screen sizes.
- The `previewEl` placeholder (skeleton preview) in `HomePage`/`TagPage` is intentionally suppressed when `blocked` — there's nothing to preview past the edge.
- No CSS changes needed — spring-back reuses `transition: transform 0.3s ease, opacity 0.3s ease` already in `onSwipeCancel`.
