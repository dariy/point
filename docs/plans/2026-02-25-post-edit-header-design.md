# Post Edit Page — Featured & Status in Title Row

**Date**: 2026-02-25
**Status**: Approved

## Summary

Move featured toggle and status selector out of the sidebar "Publish" card and into the content area title row. Remove the "Publish" sidebar card entirely.

## Layout

### Header (unchanged)
```
Edit Post              [Saved] [Save] [Cancel]
```

### Content area — title row (new)
```
[★/☆] [status▾] [  Post title input (flex: 1)  ]
```

Followed by the existing content textarea and drop zone.

## Components

### Star toggle button (`#featured-toggle`)
- Unicode ★ (filled, amber `#f59e0b`) when featured, ☆ (outline, muted) when not
- `title="Toggle featured"` tooltip
- Transparent, no-border icon button (~20px, same style as `.theme-toggle` but smaller)
- **Existing post**: immediately calls `updatePost(id, { is_featured: newVal })`; shows brief "Saved" flash in header
- **New post**: flips visual + syncs hidden checkbox; included in first manual Save

### Status pill dropdown (`#status-select`, moved from sidebar to title row)
- Uses existing `.status-select.badge-{status}` styles from `badges.css` (already fully styled)
- Options: draft / published / hidden / page
- **Existing post**: immediately calls `updatePost(id, { status: newVal })`; updates pill colour class; shows "Saved" flash
- **New post**: just changes selection value; included in first manual Save

### Title input (`#title-input`)
- `flex: 1` — fills remaining row width
- No label (placeholder "Post title" is sufficient)

## Changes

### `PostEditPage.js`
- Replace `<div class="form-group"><input id="title-input">` with a flex `div.title-row` containing star button + status select + title input
- Remove the "Publish" sidebar card (status select + featured checkbox) from the sidebar section
- Keep hidden `<input type="checkbox" id="featured-check">` so `_collectFormData()` is unchanged
- Add `_autoSaveField(patch)` method: sends partial PATCH, shows saveStatus flash, no-ops on `isNew`
- Wire star click → toggle checkbox + class + auto-save
- Wire status select change → update badge class + auto-save

### `editor.css`
- `.title-row`: `display: flex; align-items: center; gap: var(--spacing-sm);`
- `.featured-btn`: transparent icon button, amber when `.is-featured`

### `layout.css` (or inline override)
- `.light-content` on the editor page: `max-width: none` (full width)

## Non-changes
- `_collectFormData()` unchanged — reads `#status-select` and `#featured-check` as before
- Header h1 stays "Edit Post" / "New Post"
- Auto-save timer (debounced on content changes) unchanged
