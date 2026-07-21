# Media Library (`media-library`)

**Type:** route · **Routes:** `/light/media` · **Area:** `media-library` (core) · **Default:** enabled

The admin media library page: browse, upload, and manage all photos/video/audio,
filterable by folder and file type. Own single-plugin `Core` area, so it can never be
disabled from the Plugins page — the admin would otherwise have no way to manage media.

See [Media Pipeline](../features/media.md) for upload, thumbnailing, EXIF, and
visibility details (the backend service itself is not gated by this plugin — only the
admin route is).
