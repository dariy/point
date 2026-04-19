# Bulk Post Operations — Design Spec

**Date:** 2026-04-19  
**Issue:** point-d1d  
**Scope:** Frontend-only. No new API endpoints or SQL. Uses existing `setPostStatus` and `deletePost` API calls.

---

## Overview

Add an on-demand selection mode to the admin Posts List page that allows bulk status change and bulk delete across multiple posts. Designed for infrequent use — selection mode is hidden by default.

---

## 1. Selection Mode Toggle

- A `[Select]` button is added to `header-actions` (left of `+ New Post`), styled as `btn` (no special variant).
- Clicking it sets `this.state.selectMode = true` and `this.state.selectedIds = new Set()`, triggering a re-render.
- In selection mode the button becomes `[Cancel]` (same position and class). Clicking it sets `selectMode = false`, clears `selectedIds`, and re-renders.
- Selection state is ephemeral — no URL change, no persistence.

---

## 2. Checkbox Column

- When `selectMode` is true, the table gains a `<thead>` row with a `<th class="check-col">` containing a select-all checkbox.
- Each post pair (`post-row-main` + `post-row-tags`) gets a `<td class="check-col" rowspan="2">` with a single checkbox as the leftmost cell.
- `check-col` is narrow (~2rem), styled to match `preview-col` (no border-bottom on main row).
- Checking a row toggles its id in `selectedIds` and updates the toolbar count via direct DOM update (no full re-render).
- The select-all checkbox checks/unchecks all posts visible on the current page.

---

## 3. Bulk Action Toolbar

Rendered as `<div class="bulk-toolbar">` between the filters row and the table, visible only when `selectMode` is true.

Layout:
```
{N} selected  |  Status [draft ▾] [Apply]  |  [Delete selected]
```

- **Count** — updates via direct DOM mutation on checkbox change (no re-render).
- **Status dropdown** — options: `draft`, `published`, `hidden`. Plain `<select>`, no badge styling.
- **[Apply]** — disabled when `selectedIds` is empty. On click: runs sequential `setPostStatus(id, status)` for each selected id.
- **[Delete selected]** — disabled when `selectedIds` is empty. On click: shows `ConfirmDialog` ("Delete N posts? This cannot be undone."), then runs sequential `deletePost(id)` for each selected id.

---

## 4. Operation Flow

1. User confirms (for delete) or clicks Apply (for status).
2. Sequential API calls run one-by-one using existing `setPostStatus` / `deletePost`.
3. On completion (success or partial failure):
   - Full success: `"All N posts updated."` / `"All N posts deleted."` toast.
   - Partial failure: `"M of N posts updated. K failed."` toast.
4. `_load()` is called to re-fetch the list in-place (virtual reload, not `location.reload()`).
5. `selectMode` is set to `false` and `selectedIds` is cleared — selection mode exits automatically.

No per-row error indicators. No rollback on partial failure (undo mechanics are tracked separately in `point-8sn`).

---

## 5. CSS Changes

New rules in `frontend/css/light/tables.css`:
- `.check-col` — narrow checkbox column, consistent with `preview-col` spacing.
- `.bulk-toolbar` — flex row, padding consistent with `.filters`, separator between groups.
- `.bulk-toolbar select`, `.bulk-toolbar .btn` — inherit existing form/button styles, no new variants.

---

## 6. Files Affected

| File | Change |
|------|--------|
| `frontend/src/pages/light/PostsListPage.js` | Selection mode state, checkbox column, toolbar, bulk handlers |
| `frontend/css/light/tables.css` | `.check-col`, `.bulk-toolbar` styles |

No backend changes. No new API modules.
