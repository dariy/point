# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Header redesign — four zones, one fold engine**: the public header renders four zones on one row (identity · breadcrumbs · nav · tools) and a single `HeaderFold` controller decides what folds as space runs out: subtitle → ancestor crumbs → nav links into "More ▾" → nav zone into the burger → brand text → current-crumb ellipsis. The current page's name is the last thing to degrade, and every nav destination stays one tap away at any width.
- **Visible nav menu on desktop**: menu items (custom links or nav tags — one model) now render as inline links in the header, capped by the new `nav_inline_max` setting (1–10, default 4); items past the cap live under "More ▾". Items with children get breadcrumb-style dropdowns (hover-intent on mouse, tap-toggle on touch). Previously the menu existed only in the mobile burger and a hover-only flyout on the site title that never appeared on a fresh page load (first-render race).
- **`nav_menu_mode: none`**: a site can run without a menu — the header shows identity, breadcrumbs and tools only.
- **Menu editor upgrades** (`/light/menu`): source picker (Tags / Custom / None), "links shown inline" cap, and a live preview at three widths rendered by the real fold engine.
- **Deployment-injected head markup**: new `HEAD_HTML` / `CSP_SCRIPT_SRC` / `CSP_CONNECT_SRC` config lets a hosting pipeline inject per-instance `<head>` markup (analytics, verification tags) without the open-source engine hardcoding any third-party origin. Empty by default, so the shipped policy and shell are unchanged.
- **Offline password recovery**: new `point reset-password --user=<username> --password=<plaintext>` CLI command resets a user's password directly against the database for operators locked out without SMTP, plus a link to it from the login page.

### Changed
- The site-title hover flyout is no longer a menu surface (it duplicated the now-visible nav links and was unreachable on touch). Child-tag dropdowns on breadcrumbs are unchanged.
- Crumb/nav dropdown items no longer show a "0" count badge for items without post counts (e.g. custom menu links).
- **Login is now a standalone, hard-loaded `/light/login` page** instead of an in-document overlay, so the credential form always loads in a fresh document free of any markup injected via `HEAD_HTML`; logout hard-navigates to drop in-memory admin state. Two HTML shells are now built at serve time — the public shell carries `HEAD_HTML`, the admin shell (and every authenticated request) never does, keeping third-party script out of the admin DOM.

### Security
- **HTML sanitizer URL schemes**: the post content sanitizer now restricts anchor/media URLs to `http`, `https`, and `mailto` (plus relative paths) and enables URL parsing. Previously `javascript:` and `data:text/html` URLs passed through unsanitized — masked by CSP in-browser but a risk in RSS/feed-reader/email contexts. `rel="nofollow"` is now added to links. `data:` is deliberately not allowed (no post content uses `data:` images).
- **CSS sanitizer bypass hardening**: per-post CSS is now stripped of comments and CSS escape sequences (e.g. `\40 import`, `url(/**/https://…)`) are decoded before the denylist runs, closing trivial evasions of the `@import`/external-`url()`/`position`/`z-index`/`content` rules. Full CSS-parser rewrite tracked as follow-up.

### Fixed
- **WebAuthn / passkeys**: registration now requires a client-side discoverable (resident-key) credential, so a registered passkey actually has something to offer at login time — usernameless login was silently unable to find any credential before this.

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
