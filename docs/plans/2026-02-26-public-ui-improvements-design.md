# Public UI Improvements — Design

**Date:** 2026-02-26
**Branch:** experiment-go

---

## Overview

Three targeted improvements to the public blog UI:

1. Scroll indicators (fade + arrows) on the header tags bar
2. Root-level `tags-filters` visible on all pages including `/tag/<slug>`
3. Post title shown as the final breadcrumb item on post-within-tag pages

---

## Issue 1: Scroll Indicators for `header-tags-bar`

### Problem

`.tags-filters` scrolls horizontally with hidden scrollbars. There is no visual cue
that content exists beyond the visible edges.

### Solution

Wrap `.tags-filters` in a new `.tags-bar-track` container. Add gradient fade overlays
and clickable arrow buttons that appear only when content overflows in that direction.

### Implementation

**`PublicHeaderTagsBar.js`**

- Change `render()` to wrap `.tags-filters` in:
  ```html
  <div class="tags-bar-track">
    <button class="tags-scroll-btn tags-scroll-btn--left" aria-label="Scroll left" type="button">…</button>
    <div class="tags-filters is-ready" …>…</div>
    <button class="tags-scroll-btn tags-scroll-btn--right" aria-label="Scroll right" type="button">…</button>
  </div>
  ```
- In `afterRender()`:
  - Get `.tags-bar-track` and `.tags-filters`
  - Run `_updateScrollIndicators()` on load (in the existing `requestAnimationFrame` call)
  - Add `scroll` listener on `.tags-filters` → `_updateScrollIndicators()`
  - Add `click` listeners on the arrow buttons → scroll `.tags-filters` by ±200px
  - Add `resize` listener → `_updateScrollIndicators()`
- `_updateScrollIndicators()`:
  - Toggle `.has-scroll-left` on track when `scrollLeft > 0`
  - Toggle `.has-scroll-right` on track when `scrollLeft + clientWidth < scrollWidth - 2`

**`header-tags.css`**

- `.tags-bar-track`: `position: relative; overflow: hidden` (safe — dropdowns are `position: fixed` via JS)
- `.tags-bar-track::before` / `::after`: absolute gradient overlays fading from `var(--header-bg)` to transparent, `pointer-events: none`, hidden by default
- `.tags-bar-track.has-scroll-left::before`: show left fade
- `.tags-bar-track.has-scroll-right::after`: show right fade
- `.tags-scroll-btn`: small circular button, absolute-positioned over the fades, hidden by default; shown via parent's `.has-scroll-left`/`.has-scroll-right`

---

## Issue 2: Root-Level `tags-filters` on All Pages

### Problem

`GET /api/pages/tag/:slug` returns `nav_tags` = hierarchical children of the current
tag, not root-level categories. The frontend uses `data.nav_tags` for the header bar,
so tag pages show child tags instead of the global category navigation.

This also means `/tag/<slug>?slug=post-slug` (non-immersive post view) shows wrong or
empty nav tags.

### Solution

**Backend (`api/internal/api/pages.go`)**

In `GetTagPage`, add a second nav tags fetch with `parentID = nil`:
```go
rootNavTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly)
```
Return it in the response as `root_nav_tags`. Keep `nav_tags` (child tags) in case
it's used elsewhere.

**Frontend (`frontend/src/pages/public/TagPage.js`)**

Change the navTags source:
```js
// Before
const navTags = this.state.data?.nav_tags || store.get('navTags') || [];

// After
const navTags = this.state.data?.root_nav_tags || store.get('navTags') || [];
if (navTags.length) store.set('navTags', navTags);
```

Visibility rules (unchanged):
- Tag grid page: show nav tags ✓
- Post-within-tag, non-immersive: show nav tags ✓
- Post-within-tag, immersive: hide nav tags ✓ (existing `immersive ? [] : navTags`)

---

## Issue 3: Post Title in Breadcrumb

### Problem

On `/tag/krasnodar?slug=some-post`, the breadcrumb shows only the tag path
(e.g., `/ Krasnodar`). The post title is not reflected.

### Expected

```
[Logo] / Krasnodar / Street Art in Krasnodar
                ↑ tag link   ↑ post title (plain, current page)
```

### Solution

**`frontend/src/pages/public/TagPage.js`**

In the post-view branch of `afterRender()`, extend the breadcrumb with the post title
before passing to `PublicHeader`:

```js
const headerBreadcrumb = post
  ? [...breadcrumb, { name: post.title, slug: null }]
  : breadcrumb;

this.mountChild(PublicHeader, '#header-mount', {
  settings,
  navTags: immersive ? [] : navTags,
  currentTagSlug: slug,
  breadcrumb: headerBreadcrumb,   // was: breadcrumb
  currentPath: '',
});
```

The existing `PublicHeader` breadcrumb renderer already handles a trailing no-slug
item as `<span class="breadcrumb-current">` (non-linked), so no header changes are
needed.

---

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/components/public/PublicHeaderTagsBar.js` | Scroll indicator wrapper + JS |
| `frontend/css/public/header-tags.css` | Scroll indicator CSS |
| `api/internal/api/pages.go` | Add `root_nav_tags` to `GetTagPage` response |
| `frontend/src/pages/public/TagPage.js` | Use `root_nav_tags` + post title in breadcrumb |

---

## Non-Goals

- Immersive post mode rework (deferred)
- Tags bar on map page or other non-tag pages
