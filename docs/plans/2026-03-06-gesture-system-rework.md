# Gesture System Rework — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the basic swipe detector with a professional-grade unified gesture system supporting pinch-to-zoom, corrected navigation direction, and swipe-down-to-list navigation.

**Architecture:** New `GestureController` class replaces `SwipeDetector` with a proper state machine (IDLE → SINGLE_TOUCH → SWIPING_H/V | PINCHING | PANNING). PostContent manages zoom state and decides whether swipe events navigate or pan. Backend gains a `GET /api/posts/:slug/page` endpoint backed by a shared visibility helper.

**Tech Stack:** Vanilla JS (no build), Go/Echo, SQLite. Tests: `./scripts/run-tests.sh`. CSS bundle: `./scripts/build-css.sh`.

**Design doc:** `docs/plans/2026-03-06-gesture-system-rework-design.md`

---

## Task 1: Backend — Visibility Helper + Refactor pages.go

**Files:**
- Create: `api/internal/api/visibility.go`
- Create: `api/internal/api/visibility_test.go`
- Modify: `api/internal/api/pages.go` (refactor 3 inline loops to use helper)

### Step 1: Write the failing test

Create `api/internal/api/visibility_test.go`:

```go
package api

import (
	"testing"
	"point-api/internal/repository"
)

func TestIsPostVisibleToPublic(t *testing.T) {
	hidden := map[int64]bool{2: true, 5: true}

	tests := []struct {
		name     string
		tags     []repository.PostTagInfo
		expected bool
	}{
		{"no tags", []repository.PostTagInfo{}, true},
		{"tag not hidden", []repository.PostTagInfo{{ID: 1}}, true},
		{"tag hidden", []repository.PostTagInfo{{ID: 2}}, false},
		{"mixed tags, one hidden", []repository.PostTagInfo{{ID: 1}, {ID: 5}}, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := IsPostVisibleToPublic(tc.tags, hidden)
			if got != tc.expected {
				t.Errorf("got %v, want %v", got, tc.expected)
			}
		})
	}
}
```

### Step 2: Run to verify it fails

```bash
cd api && go test ./internal/api/... -run TestIsPostVisibleToPublic -v
```
Expected: compile error — `IsPostVisibleToPublic` undefined.

### Step 3: Create `api/internal/api/visibility.go`

```go
package api

import "point-api/internal/repository"

// IsPostVisibleToPublic returns true if none of the post's tags are in the
// effectively-hidden-posts set. Used to filter public post listings.
func IsPostVisibleToPublic(postTags []repository.PostTagInfo, hiddenPostsTagIDs map[int64]bool) bool {
	for _, t := range postTags {
		if hiddenPostsTagIDs[t.ID] {
			return false
		}
	}
	return true
}
```

### Step 4: Run to verify it passes

```bash
cd api && go test ./internal/api/... -run TestIsPostVisibleToPublic -v
```
Expected: PASS.

### Step 5: Refactor `pages.go` — replace inline loops with helper

In `GetHomePage` (around line 84), replace:
```go
// OLD
if publicOnly {
    hidden := false
    for _, t := range postTagsMap[p.ID] {
        if effectiveHiddenPosts[t.ID] {
            hidden = true
            break
        }
    }
    if hidden {
        continue
    }
}
```
With:
```go
// NEW
if publicOnly && !IsPostVisibleToPublic(postTagsMap[p.ID], effectiveHiddenPosts) {
    continue
}
```

Apply the same replacement in `GetTagPage` (around line 202) — same pattern, same fix.

### Step 6: Verify existing tests still pass

```bash
./scripts/run-tests.sh
```
Expected: all pass (behaviour unchanged).

### Step 7: Commit

```bash
git add api/internal/api/visibility.go api/internal/api/visibility_test.go api/internal/api/pages.go
git commit -m "refactor: extract IsPostVisibleToPublic visibility helper"
```

---

## Task 2: Backend — `ListPublishedPostStubs` Repository Method

**Files:**
- Modify: `api/internal/repository/extended.go`
- Modify: `api/internal/repository/extended_test.go`

### Step 1: Write the failing test

Add to `api/internal/repository/extended_test.go`:

```go
func TestListPublishedPostStubs(t *testing.T) {
	repo := setupTestRepo(t)

	ctx := context.Background()
	// Create two published posts
	p1, _ := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "First", Slug: "first", Content: "", Status: "published",
		PublishedAt: sql.NullTime{Time: time.Now().Add(-2 * time.Hour), Valid: true},
	})
	p2, _ := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Second", Slug: "second", Content: "", Status: "published",
		PublishedAt: sql.NullTime{Time: time.Now().Add(-1 * time.Hour), Valid: true},
	})
	// Draft — should not appear
	repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Draft", Slug: "draft", Content: "", Status: "draft",
	})

	stubs, err := repo.ListPublishedPostStubs(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(stubs) != 2 {
		t.Fatalf("expected 2 stubs, got %d", len(stubs))
	}
	// newest first
	if stubs[0].Slug != "second" || stubs[1].Slug != "first" {
		t.Errorf("wrong order: %v %v", stubs[0].Slug, stubs[1].Slug)
	}
	_ = p1; _ = p2
}
```

Note: check how `setupTestRepo` is spelled in `extended_test.go` — it may differ from `setupTestDB` in the api package. Match the existing helper name.

### Step 2: Run to verify it fails

```bash
cd api && go test ./internal/repository/... -run TestListPublishedPostStubs -v
```
Expected: compile error — method undefined.

### Step 3: Add `PostStub` type and `ListPublishedPostStubs` to `extended.go`

Add after the `PostTagInfo` type (around line 775):

```go
// PostStub is a lightweight post descriptor used for position/page lookups.
type PostStub struct {
	ID          int64
	Slug        string
	PublishedAt time.Time
}

// ListPublishedPostStubs returns id, slug, published_at for all published,
// non-hidden posts, ordered newest first. Does not include content.
func (r *Repository) ListPublishedPostStubs(ctx context.Context) ([]PostStub, error) {
	const q = `
SELECT id, slug, published_at
FROM posts
WHERE status = 'published' AND is_hidden = FALSE
ORDER BY published_at DESC, id DESC`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stubs []PostStub
	for rows.Next() {
		var s PostStub
		if err := rows.Scan(&s.ID, &s.Slug, &s.PublishedAt); err != nil {
			return nil, err
		}
		stubs = append(stubs, s)
	}
	return stubs, rows.Err()
}
```

### Step 4: Run to verify it passes

```bash
cd api && go test ./internal/repository/... -run TestListPublishedPostStubs -v
```
Expected: PASS.

### Step 5: Commit

```bash
git add api/internal/repository/extended.go api/internal/repository/extended_test.go
git commit -m "feat: add ListPublishedPostStubs repository method"
```

---

## Task 3: Backend — `GetPostPage` Handler + Route

**Files:**
- Modify: `api/internal/api/posts.go`
- Modify: `api/internal/api/posts_test.go` (or create if absent)
- Modify: `api/cmd/api/main.go`

### Step 1: Write the failing test

Add to `api/internal/api/posts_test.go` (create file if it doesn't exist):

```go
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"database/sql"
	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestPostHandler_GetPostPage(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	ctx := context.Background()
	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingSvc := services.NewSettingsService(repo)

	// Create 12 published posts (newest first by published_at)
	for i := 12; i >= 1; i-- {
		postSvc.CreatePost(ctx, services.CreatePostParams{
			Title:  fmt.Sprintf("Post %d", i),
			Slug:   fmt.Sprintf("post-%d", i),
			Status: "published",
			PublishedAt: &time.Time{}, // fill with time.Now().Add(-duration)
		})
	}
	// With per_page=10: post-1 (newest) is page 1, post-11 is page 2.

	handler := NewPostHandler(postSvc, settingSvc, nil, tagSvc)
	e := echo.New()

	t.Run("first page post", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues("post-1")

		if err := handler.GetPostPage(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		var resp map[string]interface{}
		json.NewDecoder(rec.Body).Decode(&resp)
		if int(resp["page"].(float64)) != 1 {
			t.Errorf("expected page 1, got %v", resp["page"])
		}
	})

	t.Run("unknown slug returns 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues("no-such-post")

		err := handler.GetPostPage(c)
		if err == nil {
			t.Fatal("expected error for unknown slug")
		}
		he, ok := err.(*echo.HTTPError)
		if !ok || he.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %v", err)
		}
	})
}
```

Note: the exact `CreatePost` call signature must match `services.CreatePostParams`. Check `post_service.go` for the actual field names and adapt.

### Step 2: Run to verify it fails

```bash
cd api && go test ./internal/api/... -run TestPostHandler_GetPostPage -v
```
Expected: compile error — `GetPostPage` undefined.

### Step 3: Implement `GetPostPage` in `posts.go`

Add after `GetPostBySlug`:

```go
// GetPostPage returns the home-feed page number that contains the given post slug.
// GET /api/posts/:slug/page
func (h *PostHandler) GetPostPage(c echo.Context) error {
	ctx := c.Request().Context()
	slug := c.Param("slug")

	// Verify the post exists and is published
	post, err := h.postService.GetPostBySlug(ctx, slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "post not found")
	}

	// Compute effective hidden-posts tag set
	hiddenTagIDs, _ := h.tagService.EffectivelyHiddenPostsTagIDs(ctx)

	// Fetch all published post stubs (lightweight: id, slug, published_at)
	stubs, err := h.postService.ListPublishedPostStubs(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list posts")
	}

	// Bulk-fetch tags for all stub IDs
	ids := make([]int64, len(stubs))
	for i, s := range stubs {
		ids[i] = s.ID
	}
	tagsMap, _ := h.postService.GetTagsByPostIDs(ctx, ids)

	// Walk stubs in order (newest first), apply visibility filter, find position
	position := 0
	found := false
	for _, s := range stubs {
		if !IsPostVisibleToPublic(tagsMap[s.ID], hiddenTagIDs) {
			continue
		}
		position++
		if s.Slug == post.Slug {
			found = true
			break
		}
	}
	if !found {
		return echo.NewHTTPError(http.StatusNotFound, "post not found")
	}

	perPageStr, _ := h.settingsService.GetSetting(ctx, "posts_per_page", "10")
	perPage, _ := strconv.Atoi(perPageStr)
	if perPage < 1 {
		perPage = 10
	}

	page := int(math.Ceil(float64(position) / float64(perPage)))
	return c.JSON(http.StatusOK, map[string]interface{}{
		"page":     page,
		"per_page": perPage,
	})
}
```

You'll need to add `"math"` and `"strconv"` to the import block if not already present.

Also add `ListPublishedPostStubs` to `PostService` (delegating to repo):

```go
func (s *PostService) ListPublishedPostStubs(ctx context.Context) ([]repository.PostStub, error) {
	return s.repo.ListPublishedPostStubs(ctx)
}
```

Add this to `api/internal/services/post_service.go`.

### Step 4: Run to verify it passes

```bash
cd api && go test ./internal/api/... -run TestPostHandler_GetPostPage -v
```
Expected: PASS.

### Step 5: Register route in `main.go`

In `api/cmd/api/main.go`, find the public posts route group and add:

```go
// Public — no auth required
posts.GET("/:slug/page", postHandler.GetPostPage)
```

Place it alongside the other public `GET` routes for posts (near `/:slug`).

### Step 6: Full test run

```bash
./scripts/run-tests.sh
```
Expected: all pass.

### Step 7: Commit

```bash
git add api/internal/api/posts.go api/internal/api/posts_test.go \
        api/internal/services/post_service.go api/cmd/api/main.go
git commit -m "feat: add GET /api/posts/:slug/page endpoint"
```

---

## Task 4: Frontend — Rewrite `gestures.js` with `GestureController`

**Files:**
- Rewrite: `frontend/src/utils/gestures.js`

No automated tests for frontend JS — verify manually after Task 6.

### Step 1: Replace the file contents

```js
/**
 * GestureController — unified touch gesture state machine.
 *
 * Recognises: horizontal swipe, vertical swipe, pinch, pan (while zoomed), tap, double-tap.
 * Call setZoomed(true) when the consumer has zoomed in so that horizontal drags
 * route to onPanMove instead of onSwipeMove.
 */

const STATE = {
  IDLE: 'IDLE',
  SINGLE_TOUCH: 'SINGLE_TOUCH',
  MULTI_TOUCH: 'MULTI_TOUCH',
  SWIPING_H: 'SWIPING_H',
  SWIPING_V: 'SWIPING_V',
  PINCHING: 'PINCHING',
  PANNING: 'PANNING',
};

export class GestureController {
  /**
   * @param {HTMLElement} element
   * @param {Object} opts
   * @param {Function} [opts.onSwipeMove]    (dx, dy) — real-time drag feedback
   * @param {Function} [opts.onSwipeCommit]  (dir: 'left'|'right'|'up'|'down')
   * @param {Function} [opts.onSwipeCancel]  () — drag ended without commit
   * @param {Function} [opts.onPanMove]      (dx, dy) — pan while zoomed
   * @param {Function} [opts.onPinchMove]    (scaleDelta, cx, cy) — multiplicative
   * @param {Function} [opts.onPinchEnd]     ()
   * @param {Function} [opts.onTap]          (x, y)
   * @param {Function} [opts.onDoubleTap]    (x, y)
   * @param {number}   [opts.swipeThresholdPx=50]
   * @param {number}   [opts.commitThresholdPx=12]  movement before state commits
   * @param {number}   [opts.edgeIgnorePx=30]
   * @param {number}   [opts.doubleTapMs=300]
   * @param {number}   [opts.tapMovePx=8]
   */
  constructor(element, opts = {}) {
    this._el = element;
    this._opts = {
      swipeThresholdPx: 50,
      commitThresholdPx: 12,
      edgeIgnorePx: 30,
      doubleTapMs: 300,
      tapMovePx: 8,
      ...opts,
    };
    this._state = STATE.IDLE;
    this._zoomed = false;

    // Single-touch tracking
    this._startX = 0;
    this._startY = 0;

    // Pinch tracking
    this._pinchStartDist = 0;
    this._pinchCx = 0;
    this._pinchCy = 0;

    // Double-tap tracking
    this._lastTapTime = 0;

    this._onStart  = this._onStart.bind(this);
    this._onMove   = this._onMove.bind(this);
    this._onEnd    = this._onEnd.bind(this);
    this._onCancel = this._onCancel.bind(this);

    element.addEventListener('touchstart',  this._onStart,  { passive: true });
    element.addEventListener('touchmove',   this._onMove,   { passive: false });
    element.addEventListener('touchend',    this._onEnd,    { passive: true });
    element.addEventListener('touchcancel', this._onCancel, { passive: true });
  }

  /** Call this whenever the consumer's zoom state changes. */
  setZoomed(zoomed) {
    this._zoomed = zoomed;
  }

  _emit(name, ...args) {
    if (typeof this._opts[name] === 'function') this._opts[name](...args);
  }

  _dist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _center(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  _onStart(e) {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this._startX = t.clientX;
      this._startY = t.clientY;
      this._state = STATE.SINGLE_TOUCH;
    } else if (e.touches.length === 2) {
      // Cancel any in-progress swipe
      if (this._state === STATE.SWIPING_H || this._state === STATE.SWIPING_V ||
          this._state === STATE.PANNING) {
        this._emit('onSwipeCancel');
      }
      this._pinchStartDist = this._dist(e.touches);
      const c = this._center(e.touches);
      this._pinchCx = c.x;
      this._pinchCy = c.y;
      this._state = STATE.MULTI_TOUCH;
    }
  }

  _onMove(e) {
    // Two-finger pinch
    if (e.touches.length === 2 &&
        (this._state === STATE.MULTI_TOUCH || this._state === STATE.PINCHING)) {
      e.preventDefault(); // prevent browser zoom
      this._state = STATE.PINCHING;
      const scaleDelta = this._dist(e.touches) / this._pinchStartDist;
      // Update base for next move event so delta is incremental
      this._pinchStartDist = this._dist(e.touches);
      this._emit('onPinchMove', scaleDelta, this._pinchCx, this._pinchCy);
      return;
    }

    if (e.touches.length !== 1) return;
    if (this._state !== STATE.SINGLE_TOUCH &&
        this._state !== STATE.SWIPING_H &&
        this._state !== STATE.SWIPING_V &&
        this._state !== STATE.PANNING) return;

    const t = e.touches[0];
    const dx = t.clientX - this._startX;
    const dy = t.clientY - this._startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // State commitment
    if (this._state === STATE.SINGLE_TOUCH) {
      const moved = Math.max(absDx, absDy);
      if (moved < this._opts.commitThresholdPx) return;

      if (absDx >= absDy) {
        // Edge protection: ignore swipes starting in system back-gesture zones
        if (this._startX < this._opts.edgeIgnorePx ||
            this._startX > window.innerWidth - this._opts.edgeIgnorePx) {
          this._state = STATE.IDLE;
          return;
        }
        this._state = this._zoomed ? STATE.PANNING : STATE.SWIPING_H;
      } else {
        this._state = this._zoomed ? STATE.PANNING : STATE.SWIPING_V;
      }
    }

    if (this._state === STATE.SWIPING_H || this._state === STATE.SWIPING_V) {
      this._emit('onSwipeMove', dx, dy);
    } else if (this._state === STATE.PANNING) {
      this._emit('onPanMove', dx, dy);
    }
  }

  _onEnd(e) {
    const state = this._state;
    this._state = STATE.IDLE;

    if (state === STATE.PINCHING || state === STATE.MULTI_TOUCH) {
      this._emit('onPinchEnd');
      return;
    }

    if (state === STATE.PANNING) {
      this._emit('onSwipeCancel');
      return;
    }

    if (state === STATE.SWIPING_H || state === STATE.SWIPING_V) {
      const t = e.changedTouches[0];
      const dx = t.clientX - this._startX;
      const dy = t.clientY - this._startY;
      if (state === STATE.SWIPING_H && Math.abs(dx) >= this._opts.swipeThresholdPx) {
        this._emit('onSwipeCommit', dx < 0 ? 'left' : 'right');
      } else if (state === STATE.SWIPING_V && Math.abs(dy) >= this._opts.swipeThresholdPx) {
        this._emit('onSwipeCommit', dy < 0 ? 'up' : 'down');
      } else {
        this._emit('onSwipeCancel');
      }
      return;
    }

    if (state === STATE.SINGLE_TOUCH && e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const dx = t.clientX - this._startX;
      const dy = t.clientY - this._startY;
      if (Math.sqrt(dx * dx + dy * dy) < this._opts.tapMovePx) {
        const now = Date.now();
        if (now - this._lastTapTime < this._opts.doubleTapMs) {
          this._lastTapTime = 0;
          this._emit('onDoubleTap', t.clientX, t.clientY);
        } else {
          this._lastTapTime = now;
          this._emit('onTap', t.clientX, t.clientY);
        }
      }
    }
  }

  _onCancel() {
    const state = this._state;
    this._state = STATE.IDLE;
    if (state === STATE.SWIPING_H || state === STATE.SWIPING_V || state === STATE.PANNING) {
      this._emit('onSwipeCancel');
    } else if (state === STATE.PINCHING || state === STATE.MULTI_TOUCH) {
      this._emit('onPinchEnd');
    }
  }

  destroy() {
    this._el.removeEventListener('touchstart',  this._onStart);
    this._el.removeEventListener('touchmove',   this._onMove);
    this._el.removeEventListener('touchend',    this._onEnd);
    this._el.removeEventListener('touchcancel', this._onCancel);
  }
}

/**
 * TrackpadDetector — detects horizontal trackpad swipes via wheel events.
 * Direction: deltaX > 0 → 'left' (finger moved right = content scrolls left).
 */
export class TrackpadDetector {
  /**
   * @param {HTMLElement} element
   * @param {Object} opts
   * @param {Function} opts.onHorizontal     Called with 'left' | 'right'
   * @param {number}   [opts.thresholdDeltaX=60]
   * @param {number}   [opts.maxDeltaY=30]
   * @param {number}   [opts.cooldownMs=600]
   */
  constructor(element, { onHorizontal, thresholdDeltaX = 60, maxDeltaY = 30, cooldownMs = 600 }) {
    this._el = element;
    this.onHorizontal = onHorizontal;
    this.thresholdDeltaX = thresholdDeltaX;
    this.maxDeltaY = maxDeltaY;
    this.cooldownMs = cooldownMs;
    this._lastFired = 0;

    this._onWheel = this._onWheel.bind(this);
    element.addEventListener('wheel', this._onWheel, { passive: true });
  }

  _onWheel(e) {
    const now = Date.now();
    if (now - this._lastFired < this.cooldownMs) return;
    const absDx = Math.abs(e.deltaX);
    const absDy = Math.abs(e.deltaY);
    if (absDx > this.thresholdDeltaX && absDy < this.maxDeltaY) {
      this._lastFired = now;
      if (this.onHorizontal) this.onHorizontal(e.deltaX > 0 ? 'left' : 'right');
    }
  }

  destroy() {
    this._el.removeEventListener('wheel', this._onWheel);
  }
}
```

### Step 2: Commit

```bash
git add frontend/src/utils/gestures.js
git commit -m "feat: add GestureController state machine, keep TrackpadDetector"
```

---

## Task 5: Frontend — Pinch-to-Zoom in `_initImmersive`

**Files:**
- Modify: `frontend/src/components/public/PostContent.js`

### Step 1: Update the import line

At the top of `PostContent.js`, change:
```js
import { SwipeDetector, TrackpadDetector } from '../../utils/gestures.js';
```
to:
```js
import { GestureController, TrackpadDetector } from '../../utils/gestures.js';
```

### Step 2: Replace `_initImmersive` gesture block

In `_initImmersive`, find the `// ── Gestures ──` section (around line 244). Replace everything from that comment through the `this._trackpad = new TrackpadDetector(...)` call (roughly lines 244–286) with:

```js
// ── Gestures ──
const wrapper = this.$('.immersive-wrapper');
const visuals = this.$('.immersive-visuals');

const dismiss = async () => {
  if (tagSlug) {
    navigate(`/tag/${tagSlug}`);
    return;
  }
  try {
    const res = await fetch(`/api/posts/${post.slug}/page`);
    const { page } = await res.json();
    navigate(`/?page=${page}`);
  } catch {
    navigate('/');
  }
};

// ── Zoom state ──
let currentScale = 1.0;
let pixelScale = 1.0;
let panX = 0;
let panY = 0;
// Track cumulative pan origin for each pan gesture
let panBaseX = 0;
let panBaseY = 0;

const img = visuals ? visuals.querySelector('.immersive-bg-image') : null;

const computePixelScale = () => {
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const factor = Math.min(
    visuals.clientWidth  / img.naturalWidth,
    visuals.clientHeight / img.naturalHeight,
  );
  // If factor >= 1, image is smaller than screen — no zoom available
  pixelScale = factor < 1 ? 1 / factor : 1;
};

if (img) {
  if (img.complete && img.naturalWidth) computePixelScale();
  else img.addEventListener('load', computePixelScale, { once: true });
}

const applyZoom = (animate = false) => {
  if (!img) return;
  currentScale = Math.max(1.0, Math.min(pixelScale, currentScale));
  const maxPanX = (img.offsetWidth  * (currentScale - 1)) / 2;
  const maxPanY = (img.offsetHeight * (currentScale - 1)) / 2;
  panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
  panY = Math.max(-maxPanY, Math.min(maxPanY, panY));

  img.classList.toggle('gesture-active', !animate);
  // translate is in post-scale space: divide by scale to get pre-scale pixels
  img.style.transform = `scale(${currentScale}) translate(${panX / currentScale}px, ${panY / currentScale}px)`;

  const zoomed = currentScale > 1.0;
  wrapper.dataset.zoomed = String(zoomed);
  this._gesture.setZoomed(zoomed);
};

const resetZoom = () => {
  currentScale = 1.0; panX = 0; panY = 0;
  applyZoom(true);
};

this._didSwipe = false;

this._gesture = new GestureController(wrapper, {
  onSwipeMove: (dx, dy) => {
    if (!visuals) return;
    visuals.style.transition = 'none';
    if (Math.abs(dx) >= Math.abs(dy)) {
      visuals.style.transform = `translateX(${dx}px)`;
      visuals.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / window.innerWidth));
    } else if (dy > 0) {
      const scale = Math.max(0.5, 1 - dy / window.innerHeight);
      visuals.style.transform = `translateY(${dy}px) scale(${scale})`;
      visuals.style.opacity = String(scale);
    }
  },
  onSwipeCommit: (dir) => {
    this._didSwipe = true;
    if (visuals) {
      visuals.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      visuals.style.transform = '';
      visuals.style.opacity = '1';
    }
    if (dir === 'left')  goTo(index - 1);
    if (dir === 'right') goTo(index + 1);
    if (dir === 'down')  dismiss();
  },
  onSwipeCancel: () => {
    if (visuals) {
      visuals.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      visuals.style.transform = '';
      visuals.style.opacity = '1';
    }
  },
  onPanMove: (dx, dy) => {
    panX = panBaseX + dx;
    panY = panBaseY + dy;
    applyZoom(false);
  },
  onPinchMove: (scaleDelta, cx, cy) => {
    currentScale = Math.max(1.0, Math.min(pixelScale, currentScale * scaleDelta));
    applyZoom(false);
  },
  onPinchEnd: () => {
    // Snap to fit if close enough
    if (currentScale < 1.05) resetZoom();
    else {
      panBaseX = panX;
      panBaseY = panY;
      applyZoom(true);
    }
  },
  onTap: (x, _y) => {
    // Reuse existing tap-zone navigation (left/right/center)
    const width = window.innerWidth;
    if (this._didSwipe) { this._didSwipe = false; return; }
    if (x < width * 0.3)      goTo(index - 1);
    else if (x > width * 0.7) goTo(index + 1);
    else {
      if (document.body.classList.contains('ui-hidden')) showUI();
      else if (Date.now() - this._lastShowTime >= MIN_SHOW_MS) {
        hideUI(); clearTimeout(this._idleTimer);
      }
    }
  },
  onDoubleTap: (x, y) => {
    if (currentScale > 1.0) {
      resetZoom();
    } else if (pixelScale > 1.0) {
      // Zoom to pixel-perfect, centered on tap point
      currentScale = pixelScale;
      // Center pan so the tapped pixel is under the finger
      const cx = x - visuals.clientWidth  / 2;
      const cy = y - visuals.clientHeight / 2;
      panX = -cx * (pixelScale - 1);
      panY = -cy * (pixelScale - 1);
      panBaseX = panX;
      panBaseY = panY;
      applyZoom(true);
    }
  },
});

// Reset pan base at the start of each pan gesture (touchstart with 1 finger while zoomed)
// The GestureController doesn't expose a panStart callback yet; track via onPanMove being
// called with small deltas by resetting panBase on pinchEnd / when pan resets.
// panBase is already set on pinchEnd and resetZoom above.

this._trackpad = new TrackpadDetector(wrapper, {
  onHorizontal: (dir) => goTo(index + (dir === 'left' ? -1 : 1)),
});
```

Note: The `showUI` / `hideUI` / `resetIdle` functions are defined later in `_initImmersive` — the gesture block must come **before** the UI show/hide section, or move the showUI/hideUI definitions before the gesture block. The current `_initImmersive` defines `showUI` after the gesture block — move the gesture block **after** the `showUI`/`hideUI` definitions, or hoist those definitions above. The simplest fix: move the entire gesture init block to after the `showUI`/`hideUI`/`resetIdle` definitions.

Also delete the old `this._swipe = new SwipeDetector(...)` and old `this._on(wrapper, 'pointerdown'...)` / `this._on(wrapper, 'pointerup'...)` blocks — tap handling is now inside `onTap`.

Update `beforeUnmount` to destroy `_gesture` instead of `_swipe`:
```js
this._gesture?.destroy();
this._trackpad?.destroy();
```
(replace `this._swipe?.destroy()` references with `this._gesture?.destroy()`)

### Step 3: Update `_initNormal` direction

In `_initNormal`, replace:
```js
import { SwipeDetector, TrackpadDetector } from '../../utils/gestures.js';
```
(already changed in step 1)

Replace the `_initNormal` body to use `GestureController` and fix direction:

```js
_initNormal(prevPost, nextPost) {
  this._gesture = new GestureController(this.container, {
    onSwipeMove: (dx, _dy) => {
      if (Math.abs(dx) === 0) return;
      if (dx < 0 && !prevPost) return;
      if (dx > 0 && !nextPost) return;
      this.container.style.transform = `translateX(${dx}px)`;
      this.container.style.transition = 'none';
      this.container.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / (window.innerWidth || 500)));
    },
    onSwipeCommit: (dir) => {
      this.container.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      this.container.style.transform = '';
      this.container.style.opacity = '1';
      if (dir === 'left'  && prevPost) navigate('/post/' + prevPost.slug);
      if (dir === 'right' && nextPost) navigate('/post/' + nextPost.slug);
    },
    onSwipeCancel: () => {
      this.container.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      this.container.style.transform = '';
      this.container.style.opacity = '1';
    },
  });
  this._trackpad = new TrackpadDetector(this.container, {
    onHorizontal: (dir) => {
      if (dir === 'left'  && prevPost) navigate('/post/' + prevPost.slug);
      if (dir === 'right' && nextPost) navigate('/post/' + nextPost.slug);
    },
  });
}
```

Also update `afterRender` and `beforeUnmount` to reference `this._gesture` instead of `this._swipe`.

### Step 4: Commit

```bash
git add frontend/src/components/public/PostContent.js
git commit -m "feat: add pinch-to-zoom, pan, direction reversal, swipe-down-to-list"
```

---

## Task 6: Frontend CSS Updates

**Files:**
- Modify: `frontend/css/public/immersive.css`

### Step 1: Add zoom-related rules

Append to the end of `immersive.css`:

```css
/* ── Pinch-to-zoom ── */
.immersive-bg-image {
    transform-origin: center center;
    will-change: transform;
}

/* Disable CSS transition while finger is actively moving */
.immersive-bg-image.gesture-active {
    transition: none !important;
}

/* Cursor feedback when image is zoomed in */
.immersive-wrapper[data-zoomed="true"] {
    cursor: grab;
}

.immersive-wrapper[data-zoomed="true"]:active {
    cursor: grabbing;
}
```

### Step 2: Rebuild CSS bundle

```bash
./scripts/build-css.sh
```
Expected: `frontend/css/public.bundle.css` updated without errors.

### Step 3: Commit

```bash
git add frontend/css/public/immersive.css frontend/css/public.bundle.css
git commit -m "feat: add pinch-zoom cursor and transform CSS"
```

---

## Task 7: Final Verification

### Step 1: Full test suite

```bash
./scripts/run-tests.sh
```
Expected: all pass, ≥ 80% coverage.

### Step 2: Manual gesture checks (browser DevTools mobile emulation or real device)

- [ ] Swipe left → goes to **older** post (reversed from before)
- [ ] Swipe right → goes to **newer** post (reversed from before)
- [ ] Swipe down → navigates to tag list (if in tag context) or home page at correct page
- [ ] Pinch out → image zooms in (stops at 1:1 pixel scale)
- [ ] Pinch in while zoomed → zooms out (stops at fit)
- [ ] While zoomed, horizontal drag → pans image, does NOT navigate
- [ ] Double-tap at fit → zooms to 1:1 pixels centered on tap point
- [ ] Double-tap while zoomed → resets to fit
- [ ] Trackpad horizontal swipe → direction matches touch swipe convention

### Step 3: Verify endpoint

```bash
curl http://localhost:8000/api/posts/<some-slug>/page
# Expected: {"page": N, "per_page": 10}
```

### Step 4: Final commit if any loose ends

```bash
git add -p
git commit -m "fix: gesture system final adjustments"
```
