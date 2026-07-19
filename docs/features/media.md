# Media Pipeline

A unified media library for photos, video, and audio, owned by `MediaService`
(`api/internal/services/media_service.go`) with all files under `STORAGE_PATH`, filed
by upload date (`/YYYY/MM/…`).

## What is implemented

- **Upload**: multi-format (JPEG/PNG/WebP/…, video, audio) with MIME sniffing
  (`media_mime.go`), size limit (`MAX_UPLOAD_SIZE_MB`), and **SHA256 dedup** — the same
  bytes uploaded twice resolve to one stored file (this is what makes Instagram import
  re-runs cheap).
- **Thumbnails**: generated on upload with configurable dimensions/quality
  (`THUMBNAIL_WIDTH/HEIGHT`); bulk rebuild (all or missing-only) from `/light/system`.
- **EXIF**: extraction from JPEGs (camera, exposure, ISO, focal length, GPS, date);
  admin-editable with revert-to-original (`exif_writer.go` writes changes back).
- **Photo library import**: `PHOTO_LIBRARY_PATH` points at a read-only library (e.g. a
  Lightroom export); Point imports new files without moving originals. Also exposed as
  a picker (`PhotoLibraryPickerDialog`) and as the sandbox root for MCP uploads.
- **Library UI**: folder-tree browser (breadcrumb + folder chips on narrow screens),
  type filters, rename with safe-character validation (post references stay intact),
  orphaned-media detection and cleanup (individual or bulk), storage stats by type.
- **Drag-and-drop creation**: dropping an image anywhere in the admin uploads it and
  opens a new post pre-populated with that media; the Web Share Target (PWA) feeds the
  same flow from a phone's share sheet.

## Media visibility

Media files are **private until referenced by a visible published post** — visibility
is recalculated from post state, with a recalc endpoint for repair. This is
server-enforced (guests can't fetch media belonging to hidden/draft posts).

Gotchas from production:

- The sync has failed silently in several places historically — treat
  visibility-sync errors as privacy bugs, never best-effort.
- A post being "visible" includes tag-driven hiding (see
  [hidden-visibility.md](hidden-visibility.md)): a hidden feature-tag once made public
  feature pages lose their media.
- Batch recalcs have a known N+1.

## Key decisions

- **Content-addressed dedup at the service layer** rather than per-caller checks.
- **Posts reference media by path** (serialized in post content nodes, matched by
  `IMAGE_PATH_RE` in the editor) — renames go through the service so references update.
- **Originals are immutable-ish**: EXIF edits keep the original values recoverable.
- SVG uploads are currently allowlisted but served unsanitized same-origin — open
  security item.
