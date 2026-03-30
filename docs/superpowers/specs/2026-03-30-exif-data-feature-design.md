# EXIF Data Feature — Design Spec

**Date**: 2026-03-30
**Issue**: point-ppd
**Status**: Approved

---

## Overview

Show, edit, and control visibility of EXIF metadata for media attached to posts. EXIF is already extracted at upload time and stored as a JSON blob in `media.metadata`. This feature surfaces that data in the admin UI (editable), the public post view (read-only, visibility-gated), and adds a settings key to control public visibility.

---

## Section 1: Data Layer

**No schema changes.** The existing `media.metadata TEXT` (JSON blob) column is the editable EXIF store. User edits overwrite it in place — the edited value becomes the canonical EXIF.

### sqlc query update required

The existing `UpdateMedia` SQL query in `api/sql/queries.sql` only sets `alt_text`, `caption`, and `post_id`. It must be extended to also set `metadata`. After editing the query, run `sqlc generate` from `api/` to regenerate `internal/models/`.

The service-layer `UpdateMediaParams` struct must add `Metadata *map[string]interface{}` (pointer). In `UpdateMedia()`, convert a non-nil pointer to a `sql.NullString` (serialize to JSON; empty map serializes to `"{}"`). A nil pointer must not update the `metadata` column — the SQL query must only set `metadata` when the value is provided. Use a conditional or a separate query variant if sqlc cannot express optional columns natively.

The handler's `UpdateMediaRequest` must also use a pointer (`*map[string]interface{}`) — see Section 2.

### Re-extract sub-feature

A "Re-extract from file" action re-reads the original file from disk, runs `extractEXIF()`, and writes the result back to `metadata`. If `extractEXIF()` returns an empty map (file has no EXIF), `metadata` is still overwritten with the empty object — the user explicitly chose to reset. A toast informs them that no EXIF was found. This is the reset path — it discards any manual edits.

---

## Section 2: API Changes

### Extend `PATCH /api/media/:id`

Add `Metadata *map[string]interface{}` (pointer, JSON key `"metadata"`) to `UpdateMediaRequest`. A nil pointer (field absent from request body) leaves existing metadata unchanged. A non-nil pointer — including an explicit empty object `{}` — completely replaces the stored `metadata` JSON. The pointer type is required so that a PATCH updating only `alt_text` cannot silently wipe `metadata`.

Requires the sqlc query update described in Section 1.

### New `POST /api/media/:id/reextract`

- **Auth**: sits under the existing auth-guarded route group — admin-only, same as all other write endpoints
- **File path**: `filepath.Join(cfg.StoragePath, "media", media.OriginalPath)` — consistent with the existing pattern throughout the service layer
- **Path traversal guard**: `base = filepath.Clean(filepath.Join(cfg.StoragePath, "media"))`, `full = filepath.Clean(filepath.Join(base, media.OriginalPath))`, assert `strings.HasPrefix(full, base+string(filepath.Separator))` before reading. Note: `OriginalPath` in the DB is `originals/YYYY/MM/filename` so the resolved path is inside `<StoragePath>/media/originals/…` — the guard base is `<StoragePath>/media`, not `originals`.
- Runs the existing `extractEXIF()` on the resolved file
- Overwrites `media.metadata` with the result (may be an empty object — see Section 1)
- Returns the updated media object (same shape as `GET /api/media/:id`)
- Returns `404` if the media record is not found; `500` if the file cannot be read from disk (consistent with how disk-read failures are handled elsewhere)

### Settings — `exif_visibility`

New key in `blog_settings`:

| Key | Type | Default | Values |
|-----|------|---------|--------|
| `exif_visibility` | string | `hide` | `hide`, `admin`, `all` |

Added to `publicSettingKeys` in `settings.go` so unauthenticated frontends can read it. No DB migration seed is needed — the frontend treats an absent or unrecognised value as `hide`.

### Extend post response to include `media` array

The public `GET /api/posts/:slug` response (and the equivalent preview/ID endpoints) currently does not include a `media` array — `post.media` on the frontend is always `[]`. This feature requires the post response to include an array of media objects (with `path`, `metadata`, and `alt` fields) so the public UI can build the per-image EXIF overlays.

`buildPostResponse` in `api/internal/api/posts.go` must accept an optional `[]models.Medium` slice and, when provided, append a `"media"` key to the response. Each entry uses a subset of `mediaToResponse`: `path`, `metadata`, and `alt_text`. The `GetPostBySlug` handler must fetch `ListMediaForPost(postID)` and pass the result to `buildPostResponse`. Apply the same to `GetPostByPreviewToken` and `GetPostByID` for consistency.

---

## Section 3: Admin UI

### Security

EXIF field names and values are untrusted input (camera-controlled or user-controlled). Every render path uses `escapeHtml()` on both keys and values. Save paths read from `<input>`/`<textarea>` DOM values — never from `innerHTML`.

### `/light/media` — MediaBrowser EXIF panel

Extend the existing media detail/edit panel with a collapsible **EXIF** section containing:

- A key-value table — each row has an editable field-name input and an editable value input
- A **+ Add field** button that appends a blank row
- A **×** delete button per row
- A **Re-extract from file** button (bottom of section) — shows a confirmation dialog before overwriting; on success, re-renders the table with the new values and shows a toast; if the file had no EXIF, shows a toast: "No EXIF data found in this file."
- A **Save** button — sends the full `metadata` object via `PATCH /api/media/:id`; shows a success/error toast

### `/light/posts/:id/edit` — VisualEditor per-image EXIF

Each image card in the VisualEditor gets an **EXIF** toggle button. Clicking expands an inline EXIF panel below that card's thumbnail — same key-value editor as the MediaBrowser panel.

PostEditPage passes a `mediaByPath` prop (path → full media object) to VisualEditor so it can resolve the media ID from `node.path`. The EXIF panel includes an explicit **Save** button; on click it calls `PATCH /api/media/:id` and shows a toast for success/error. Save is per-image and independent of the post save action.

### `/light/settings` — Display group

Add `exif_visibility` to the Display settings group:

```
EXIF visibility   [Hide ▼]   (options: Hide | Admins only | Everyone)
```

Stored as `hide` | `admin` | `all` respectively.

---

## Section 4: Public UI

EXIF is shown per image. The ℹ button and overlay are only rendered for images that have at least one EXIF entry (non-empty `metadata` object). Images with no EXIF get no UI.

Visibility gating (both modes):

| `exif_visibility` | Behaviour |
|-------------------|-----------|
| `hide` | No EXIF UI rendered |
| `admin` | EXIF UI rendered only when `store.get('user')` is set (the correct store key) |
| `all` | EXIF UI always rendered |

### Immersive mode

The existing toggleable info overlay gains an EXIF sub-panel. When the active slide changes (via `goTo(i)`), the handler looks up `post.media[i].metadata` and re-renders the EXIF table in the panel. If the current media item has no EXIF entries (empty or missing `metadata`), the sub-panel is hidden for that slide.

### Normal mode

After `_enhanceMedia` runs, build a path-keyed lookup map: for each item in `post.media`, normalise `item.path` (already a root-relative path like `/2024/03/file.jpg`) as the key. For each `<img>` in the rendered content, normalise `img.src` by stripping the document origin and stripping any `?thumb` query param suffix, then look up the result in the map.

Images that match a media object with at least one EXIF entry receive:
- A wrapping `<figure>` with `position: relative`
- A small **ℹ** button positioned top-right
- A semi-transparent EXIF overlay `<div>` that toggles on button click

All rendered EXIF field names and values pass through `escapeHtml()`.

---

## Out of Scope

- GPS coordinates rendered as a map link (tracked separately as point-9an)
- Bulk EXIF re-extraction across all media
- EXIF display on audio/video media
