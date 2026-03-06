# Gesture Navigation — Implementation Plan

> **Date**: 2026-03-05
> **Design doc**: `docs/plans/2026-03-05-gesture-navigation-design.md`
> **Branch**: `claude/gesture-navigation-<hash>`

---

## 1. Context

The public interface lacks swipe and trackpad gesture support. All navigation currently requires tapping/clicking explicit UI controls.

Surfaces to add gestures to:
- **Immersive mode** — replace inline touch handling with `SwipeDetector`; add vertical dismiss; add `TrackpadDetector`
- **Normal post view** — new `_initNormal()` with `SwipeDetector` + `TrackpadDetector`
- **Home grid** — page-flip swipe (multi-page only)
- **Tag grid** — page-flip swipe (multi-page only)

All gesture logic is centralised in a new utility module. No backend changes. No CSS changes.

---

## 2. Steps

### Step 1 — Create `frontend/src/utils/gestures.js`

New file containing two classes:

**`SwipeDetector`**
- Constructor: `(element, { onHorizontal, onVertical, thresholdPx=50, edgeIgnorePx=30 })`
- Listens to `touchstart` (record `startX`, `startY`) and `touchend` (evaluate gesture)
- On `touchend`:
  - Compute `dx`, `dy`
  - If `startX < edgeIgnorePx` or `startX > window.innerWidth - edgeIgnorePx` → return
  - If horizontal dominant and exceeds threshold → `onHorizontal('left' | 'right')`
  - If vertical dominant and exceeds threshold → `onVertical('up' | 'down')`
- All listeners `{ passive: true }`
- `destroy()` removes both listeners

**`TrackpadDetector`**
- Constructor: `(element, { onHorizontal, thresholdDeltaX=60, maxDeltaY=30, cooldownMs=600 })`
- Listens to `wheel` events
- Fires `onHorizontal` when `abs(deltaX) > thresholdDeltaX && abs(deltaY) < maxDeltaY` and cooldown elapsed
- Direction: `deltaX > 0` → `'left'`, `deltaX < 0` → `'right'`
- Listener `{ passive: true }`
- `destroy()` removes listener

---

### Step 2 — Refactor `PostContent._initImmersive()` + add `_initNormal()`

**In `_initImmersive()`:**
- Remove the existing inline `touchstart` / `touchend` block
- Import and instantiate `SwipeDetector` on the wrapper element:
  - `onHorizontal`: existing `goTo(index + (dir==='left' ? 1 : -1))` logic
  - `onVertical('down')`: new `dismiss()` function
- Add `dismiss()`:
  ```js
  const dismiss = () => {
    if (tagSlug) navigate(`/tag/${tagSlug}`);
    else history.back();
  };
  ```
- Instantiate `TrackpadDetector` on wrapper with same horizontal callback
- Store as `this._swipe` and `this._trackpad`
- In `beforeUnmount()`: call `this._swipe?.destroy()` and `this._trackpad?.destroy()`

**New `_initNormal(prevPost, nextPost)`:**
- Called from `afterRender()` when not in immersive mode and neighbour posts exist
- `SwipeDetector` on `this.container`:
  - `onHorizontal('left')`: `nextPost && navigate('/post/' + nextPost.slug)`
  - `onHorizontal('right')`: `prevPost && navigate('/post/' + prevPost.slug)`
- `TrackpadDetector` on same element with same callbacks
- Store and destroy alongside existing listeners

---

### Step 3 — Add swipe to `HomePage`

In `afterRender()`, after mounting `PostGrid`:
- Read current page: `const page = parseInt(this.props.query?.page || '1', 10)`
- Only proceed when `pagination.pages > 1`
- Instantiate `SwipeDetector` on `this.container`:
  - `'left'` → `page < pagination.pages && navigate('/?page=' + (page + 1))`
  - `'right'` → `page > 1 && navigate('/?page=' + (page - 1))`
- Instantiate `TrackpadDetector` with same callback
- Store as `this._swipe` / `this._trackpad`

Add `beforeUnmount()` to `HomePage`:
```js
beforeUnmount() {
  this._swipe?.destroy();
  this._trackpad?.destroy();
}
```

---

### Step 4 — Add swipe to `TagPage`

Same pattern as Step 3, applied in the `else` (grid) branch of `afterRender()`.

URLs: `/tag/${slug}?page=${page + 1}` and `/tag/${slug}?page=${page - 1}`.

Add `beforeUnmount()` to `TagPage`:
```js
beforeUnmount() {
  this._swipe?.destroy();
  this._trackpad?.destroy();
}
```

---

## 3. Files Changed

| File | Change |
|------|--------|
| `frontend/src/utils/gestures.js` | **New** — `SwipeDetector` + `TrackpadDetector` |
| `frontend/src/components/public/PostContent.js` | Refactor immersive touch; add `_initNormal()`; update `beforeUnmount()` |
| `frontend/src/pages/public/HomePage.js` | Add grid swipe; add `beforeUnmount()` |
| `frontend/src/pages/public/TagPage.js` | Add grid swipe; add `beforeUnmount()` |

---

## 4. Verification Checklist

### Touch (mobile)

- [ ] **Immersive carousel**: swipe left advances image; swipe right retreats; at image boundary, advances/retreats to adjacent post
- [ ] **Immersive single image**: swipe left/right navigates to next/prev post
- [ ] **Immersive dismiss**: swipe down navigates to `/tag/${slug}` (when tag context) or triggers `history.back()` (when opened from home/direct)
- [ ] **Normal post view**: swipe left navigates to next post; swipe right navigates to prev post; no-op when neighbour is absent
- [ ] **Home grid (multi-page)**: swipe left → next page; swipe right → prev page; no-op at boundaries
- [ ] **Tag grid (multi-page)**: same as home grid with tag-scoped URLs
- [ ] **Edge protection**: swipe starting within 30 px of left edge does not navigate (iOS Safari back gesture unaffected); same for right edge (Android back gesture unaffected)
- [ ] **Single-page grid**: no swipe detector attached (pagination.pages === 1)

### Desktop trackpad

- [ ] **Immersive**: horizontal trackpad swipe navigates between images/posts
- [ ] **Normal post**: horizontal trackpad swipe navigates between posts
- [ ] **Home grid (multi-page)**: horizontal trackpad swipe flips pages
- [ ] **Tag grid (multi-page)**: horizontal trackpad swipe flips pages
- [ ] **Cooldown**: two rapid consecutive trackpad swipes produce exactly one navigation
- [ ] **Mouse scroll**: vertical mouse scroll does not trigger horizontal navigation

### Keyboard regression

- [ ] Immersive arrow keys still work
- [ ] Immersive space / home / end still work

### Listener cleanup

- [ ] Navigating away from immersive mode removes swipe + trackpad listeners
- [ ] Navigating away from a normal post removes listeners
- [ ] Navigating away from home/tag grid removes listeners
- [ ] No duplicate listeners on repeated visits to the same page
