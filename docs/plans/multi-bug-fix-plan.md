# Multi-Bug Fix Plan
**Date:** 2026-03-09
**Branch:** `claude/fix-multiple-bugs-yNPCy`
**Status:** In Progress

---

## Overview

Comprehensive plan to address 20 reported issues across the Point photo blog engine.
Issues are grouped by area and ordered by implementation complexity.

---

## Group A — Post Card & Public Feed

### A1. Show all visible tags + parent tags in PostCard
**Files:** `frontend/src/components/public/PostCard.js`, `api/internal/api/mappers.go`
**Complexity:** Medium

Currently: `.slice(0, 3)` limits to 3 tags; parent tags are never included.

- Remove the `.slice(0, 3)` cap from `PostCard.js:45`.
- The API already returns `post.tags[]`. Parent tags are NOT included in the list-post response; they must be expanded by the backend.
- Backend change: in `postToResponse` / `postByTagToResponse` (`mappers.go`), expand the `tags` field to include all direct tags **plus** their ancestors (parents, grandparents…), deduplicated, filtering out tags with `is_hidden = true` for public requests.
- Frontend: render all tags returned by the API in PostCard without any slice cap.

---

## Group B — Map

### B1. Canada shows 0 posts (but Montreal has posts)
**Files:** `api/internal/api/pages.go:GetMapPage`
**Complexity:** Low

Root cause: `post_count` on a tag only counts posts **directly** tagged with that tag. "Canada" has no posts tagged directly — only "Montreal" does.

- Backend fix in `GetMapPage`: compute a **hierarchical post count** = sum of `post_count` across the tag itself and all of its descendants (already available via `GetTagDescendants` used in the same handler).
- Add a helper that accumulates counts from all descendant tags.
- Use this hierarchical count as `post_count` in the map JSON response.

---

## Group C — Admin Layout / Navigation

### C1. Portrait mode: burger menu + slide-in sidebar
**Files:** `frontend/src/components/light/AdminLayout.js`, `frontend/src/components/light/LightSidebar.js`, CSS
**Complexity:** Medium

- Add a hamburger button to `AdminLayout.js` top bar (visible only in portrait/mobile via CSS media query).
- `LightSidebar.js`: add an `isOpen` prop; render with a `.sidebar-open` CSS class when open.
- CSS: when viewport is portrait or `max-width < 768px`, position the sidebar off-screen to the left by default; slide in when `.sidebar-open`.
- Overlay div behind sidebar closes it on tap.
- Store open/closed state in `AdminLayout`, pass it down as prop; clicking hamburger toggles state.

### C2. Pull-to-refresh for all `/light/*` pages
**Files:** `frontend/css/light/` (CSS bundle)
**Complexity:** Low

- The browser native pull-to-refresh is suppressed by `overscroll-behavior-y: none` (or similar) in the light CSS.
- Remove or scope it so it doesn't apply at the `body` / `html` level for admin pages.
- Elements needing scroll lock (e.g. immersive mode overlay) should apply it locally, not globally.
- Rebuild CSS bundle after change (`scripts/build-css.sh`).

---

## Group D — Post Editor Bugs

### D1. Status select always shows "Draft" on open
**Files:** `frontend/src/pages/light/PostEditPage.js`
**Complexity:** Low

Root cause: `_collectFormData()` returns `this.$('#status-select')?.value || 'draft'`. When `_autoSaveField` is triggered (e.g. by a featured-toggle click) and the select somehow isn't in the DOM, status is saved as `'draft'` to the API; the API response then overwrites `this.state.post.status = 'draft'`. On next render, the select shows `'draft'`.

- Fix: in `_collectFormData()`, prefer `this.state.post?.status` over the DOM value as primary source:
  `status: this.$('#status-select')?.value || this.state.post?.status || 'draft'`
- Also normalize `post.status` to lowercase on load in `_loadPost`:
  `post.status = (post.status || 'draft').toLowerCase()`

### D2. Analyze button resets user's unsaved field values
**Files:** `frontend/src/pages/light/PostEditPage.js`
**Complexity:** Low

Root cause: `setState({ analyzing: true })` triggers a full re-render using `this.state.post` (last-saved values), discarding the user's typed-but-unsaved text.

- Fix: avoid calling `setState({ analyzing: true })` before the API call. Instead, directly add a CSS loading class to the button and set a local boolean flag.
- Call `setState({ analyzing: false, post })` only once after the API response.
- Same fix applies to `_doAnalyzeField`: skip the `setState({ analyzingField })` re-render; manipulate button state via direct DOM toggle instead.

### D3. Autosave saves content to the wrong post
**Files:** `frontend/src/pages/light/PostEditPage.js`, `frontend/src/utils/helpers.js`
**Complexity:** Low (flag approach)

Root cause: `debounce()` has no `.cancel()` method. When the user navigates from post A to post B, the 30-second debounce timer fires on the old `PostEditPage` instance. `_collectFormData()` reads the **new** post's DOM (same container, reused by router), and saves it to the **old** post's ID.

- Add `this._unmounted = false` flag in constructor; set `this._unmounted = true` in `beforeUnmount()`.
- At the start of `_autosave()`, bail out immediately if `this._unmounted`.
- Optionally: add a `.cancel()` method to `debounce` in `helpers.js` and call it in `beforeUnmount`.

### D4. Drag-and-drop in VisualEditor doesn't work on iPad
**Files:** `frontend/src/components/light/VisualEditor.js`
**Complexity:** High

Root cause: all drag listeners use `mousedown` / `dragstart` / `dragover` / `drop` — mouse-only events that don't fire on iOS.

- Replace with the **Pointer Events API** (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) which works for both touch and mouse.
- The drag handle (`.ve-handle`) gets `touch-action: none` CSS to prevent scroll interference.
- Implement position tracking via `pointermove`, detect drag threshold, clone dragged item as a placeholder, drop on `pointerup`.

---

## Group E — Immersive Mode

### E1. Don't hide overlay until press/tap is released
**Files:** `frontend/src/components/public/PostContent.js`
**Complexity:** Low

Root cause: `mousedown` listener at line 475 calls `resetIdle` → `showUI()` which restarts the 2-second countdown even while the user is still holding.

- On `touchstart` / `mousedown` / `pointerdown`: call `clearTimeout(this._idleTimer)` to **pause** the countdown.
- On `touchend` / `mouseup` / `pointerup`: restart it: `this._idleTimer = setTimeout(hideUI, IDLE_MS)`.
- The overlay stays visible for exactly `IDLE_MS` after the user **releases**, not while pressing.

### E2. Immersive mode: show excerpt in top-left corner
**Files:** `frontend/src/components/public/PostContent.js`, `frontend/src/pages/light/SettingsPage.js`, backend settings
**Complexity:** Medium

- In `_renderImmersive()`, add a `.post-excerpt-card` div positioned top-left (below the header) containing `post.excerpt`.
- This element obeys the `.ui-hidden` class (fades with the rest of the UI).
- Add setting key `show_immersive_excerpt` (boolean, default `true`) to `blog_settings`.
- In `/light/settings`, add a checkbox "Show excerpt in immersive mode".
- Read setting from page response and pass it as a prop to `PostContent`.

---

## Group F — Tags

### F1. "City" tag shown regardless of settings
**Files:** `frontend/src/components/public/PublicHeaderTagsBar.js`, `api/internal/services/tag_service.go`
**Complexity:** Low

Root cause: `GetHierarchicalNavTags` may not filter parent-category tags with `is_hidden = true` (or the "City" tag has `is_hidden = false` but appears in nav unexpectedly).

- Verify `GetHierarchicalNavTags` in `tag_service.go` excludes tags where `is_hidden = true` (for public requests).
- In `PublicHeaderTagsBar.js`: filter the `navTags` array by `!tag.is_hidden` before rendering as additional safety net.

### F2. Tag creation: show existing post count
**Files:** `frontend/src/pages/light/TagsManagerPage.js`
**Complexity:** Low

- In the tag editor modal, below or next to the tag name, display:
  `<span class="post-count-badge">${tag.post_count} posts</span>` (only for existing tags; hidden when creating).
- `post_count` is already in the API tag response.

### F3. Tree view of Parents and Children in tag editor
**Files:** `frontend/src/pages/light/TagsManagerPage.js`
**Complexity:** Medium

Currently parents/children are shown as flat toggle lists.

- Add a recursive `renderTagTree(tags, allTags, selected, depth)` helper inside `TagsManagerPage`.
- Use the existing `tag_relationships` data (already in the API response) to build the tree.
- Indent child items visually (padding-left per depth level).
- Keep the same toggle/checkbox behaviour.

### F4. Show action buttons in tag list view
**Files:** `frontend/src/pages/light/TagsManagerPage.js`
**Complexity:** Low

- In the list view (`renderListView`), add Edit and Delete icon buttons to each row.
- Wire Edit to open the existing tag edit modal; Delete to the existing delete confirmation flow.
- Style as small icon buttons (pencil / trash), consistent with `PostsListPage`.

### F5. Hide tags from public with fewer than N posts
**Files:** `frontend/src/pages/light/SettingsPage.js`, `api/internal/services/tag_service.go`, `api/internal/api/pages.go`
**Complexity:** Medium

- Add `min_tag_posts_to_show` setting (integer, default `2`) to `blog_settings`.
- Add number input "Minimum posts to show tag publicly" in `SettingsPage.js` (Display group).
- Backend: read this setting in `GetHierarchicalNavTags`, `GetTagCloud`, and `ListTags` (public path) to filter out tags where `post_count < min_tag_posts_to_show`.
- Apply the same filter in `GetMapPage` map markers.

---

## Group G — Media

### G1. Media rename: allow only letters, digits, minus, underscore
**Files:** `frontend/src/components/light/MediaBrowser.js`, `frontend/src/components/light/VisualEditor.js`, `api/internal/api/media.go`
**Complexity:** Low

- In `MediaBrowser._showRenamePrompt()`: after reading `newName.trim()`, apply:
  `const safe = newName.trim().replace(/[^a-zA-Z0-9\-_]/g, '');` and use `safe` for the API call. Show error if `safe` is empty.
- Same filter in `VisualEditor.js` inline rename: validate on form submit.
- Backend (`media.go → RenameMedia`): add server-side validation: `/^[a-zA-Z0-9_-]+$/` before processing; return 400 if invalid.

### G2. Add excerpt text as alt text to all images
**Files:** `frontend/src/components/public/PostContent.js`
**Complexity:** Low

- In `PostContent._enhanceMedia()` (line 579), after querying all images, for any `<img>` missing an `alt` attribute, set:
  `img.alt = img.alt || post.excerpt || post.title || '';`

---

## Group H — Post List Table UI

### H1. Fix post table action column UI
**Files:** `frontend/css/light/` (table CSS), `frontend/src/pages/light/PostsListPage.js`
**Complexity:** Low

Two specific issues:
1. **Border-bottom visual artifact**: find and fix the `td.actions` CSS rule creating unwanted dividers between buttons.
2. **Stacking when row height increases**: apply `display: flex; flex-wrap: wrap; gap: 4px` to `.actions` so buttons stack vertically on narrow/tall rows instead of expanding the column.

---

## Group I — Settings / About Page

### I1. About page: copyright link in footer
**Files:** `frontend/src/pages/light/SettingsPage.js`, `frontend/src/components/public/PublicFooter.js`
**Complexity:** Low

`about_post_id` already exists in `pagePublicSettingKeys` in `pages.go` — just needs UI and usage.

- **SettingsPage.js**: add a text input for `about_post_id` in the General group ("About page post ID or slug"). Include a preview link when a value is set.
- **PublicFooter.js**: read `settings.about_post_id`. If set, the copyright `<a>` links to `/post/${settings.about_post_id}`; otherwise keep current `/light` link.

---

## Implementation Order

### Phase 1 — Low complexity (standalone fixes)
`C2, D1, D3, E1, F1, F2, F4, G1, G2, H1, I1, B1`

### Phase 2 — Medium complexity (multi-file coordination)
`A1, C1, D2, E2, F3, F5`

### Phase 3 — High complexity (needs device testing)
`D4`

### Deferred
- **Legorover bug** — investigate in a separate session.
