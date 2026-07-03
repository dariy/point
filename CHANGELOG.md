# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **HTML sanitizer URL schemes**: the post content sanitizer now restricts anchor/media URLs to `http`, `https`, and `mailto` (plus relative paths) and enables URL parsing. Previously `javascript:` and `data:text/html` URLs passed through unsanitized — masked by CSP in-browser but a risk in RSS/feed-reader/email contexts. `rel="nofollow"` is now added to links. `data:` is deliberately not allowed (no post content uses `data:` images).
- **CSS sanitizer bypass hardening**: per-post CSS is now stripped of comments and CSS escape sequences (e.g. `\40 import`, `url(/**/https://…)`) are decoded before the denylist runs, closing trivial evasions of the `@import`/external-`url()`/`position`/`z-index`/`content` rules. Full CSS-parser rewrite tracked as follow-up.

### Fixed
- **Database initialization**: Improved reliability of first-run schema setup by splitting SQL statements and using transactions, fixing an issue where tables could be missing on some environments (e.g. rootless Podman).

## [0.1.0] - TBD

### Added
- **Core blog engine**: self-hosted personal photo blog with Go + Echo v4 backend and Vanilla JS SPA frontend
- **SQLite storage** via sqlc — no external database required
- **Single-container deployment**: multi-stage Dockerfile, runs as non-root, multi-arch (amd64 + arm64) images on GHCR
- **Media management**: upload, thumbnail generation, EXIF extraction, bulk import
- **AI media analysis**: Google Gemini integration for automatic title, tags, and excerpt suggestions
- **Timeline navigation**: interactive SVG timeline with tag-based filtering and year/location drill-down
- **Post scheduling**: publish posts at a future date/time; background scheduler publishes on time
- **Themes**: built-in light/dark themes plus CSS custom property overrides
- **Lightbox**: keyboard-accessible full-screen media viewer
- **Setup wizard**: one-time configuration flow on first boot
- **Session-cookie auth**: bcrypt passwords, configurable session TTL
- **Secrets architecture**: sensitive values stored in a separate `blog_secrets` table, never exposed via API
- **Graceful shutdown**: SIGTERM/SIGINT triggers clean shutdown with 30-second drain window
- **Health endpoint**: `GET /health` for container health checks and orchestration
- **Version endpoint**: `GET /api/system/version` reports the running release tag
- **GHCR release pipeline**: GitHub Actions publishes `ghcr.io/dariy/point:{tag,latest}` on version tags

[Unreleased]: https://github.com/dariy/point/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dariy/point/releases/tag/v0.1.0
