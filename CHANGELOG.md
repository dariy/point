# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**How releases are cut:** `.github/workflows/tag-release.yml` tags a new patch
version on every merge to `main` and builds a release from it, so the shipped
tags (`v0.1.x`) advance far faster than the entries below. This file records
notable changes, not one section per tag — consult `git tag -l` for the exact
list of published releases.

## [Unreleased]

### Added
- **GitHub Releases and native linux tarballs**: every version tag now publishes a GitHub Release with notes and two attached archives, `point-linux-amd64.tar.gz` and `point-linux-arm64.tar.gz` (plus `checksums.txt`). This makes the documented native install real: `quickstart/install.sh --method=native` downloaded a tarball that had never been uploaded, from a `releases/latest` endpoint that 404'd, and reported it as "check your internet connection". Each archive carries the server, `migrate-paths`, `data.yml` and the built frontend, and the release job boots the amd64 one and serves a page from it before publishing. New `scripts/build-tarball.sh` produces the same archive locally; `scripts/release-notes.sh` derives the release body from this file plus the tag's commit range.
- **Migrations roll back**: a boot with pending schema migrations now takes a `VACUUM INTO` snapshot of the database first (`data/backups/migrations/premigration_<ts>.db`) and puts it back if the migrations fail, so a failed upgrade leaves the database exactly as it was instead of half-migrated. The snapshot is skipped entirely when nothing is pending, so ordinary restarts cost nothing; a snapshot that cannot be taken stops the boot rather than migrating unprotected (`MIGRATION_BACKUP=false` overrides, `MIGRATION_BACKUP_KEEP` sets retention). An interrupted restore is finished on the next boot, before the database is opened. New `scripts/restore-db.sh` does the same thing by hand, from either a snapshot or a backup archive.
- **Swipe and pinch on the media library** (`/light/media`): the admin media grid now takes the same two gestures the public post grids have had — swipe left/right to page through the listing (with the neighbouring page preloaded and sliding in under the finger, and a rubber-band at either end), and pinch to zoom the thumbnail size. Zoom is a pinned column count, sticky per browser, and is also reachable from a trackpad (ctrl+wheel, Safari's pinch) and the `+`/`-` keys; paging also answers arrow keys, `h`/`j`/`k`/`l`, two-finger trackpad flicks and the hover chevrons already used by the post list. Lives in `frontend/src/core/mediaPager.js`, a sibling of the public grid's `core/gridPager.js` reading the same gesture recogniser.
- **Header redesign — four zones, one fold engine**: the public header renders four zones on one row (identity · breadcrumbs · nav · tools) and a single `HeaderFold` controller decides what folds as space runs out: subtitle → ancestor crumbs → nav links into "More ▾" → nav zone into the burger → brand text → current-crumb ellipsis. The current page's name is the last thing to degrade, and every nav destination stays one tap away at any width.
- **Visible nav menu on desktop**: menu items (custom links or nav tags — one model) now render as inline links in the header, capped by the new `nav_inline_max` setting (1–10, default 4); items past the cap live under "More ▾". Items with children get breadcrumb-style dropdowns (hover-intent on mouse, tap-toggle on touch). Previously the menu existed only in the mobile burger and a hover-only flyout on the site title that never appeared on a fresh page load (first-render race).
- **`nav_menu_mode: none`**: a site can run without a menu — the header shows identity, breadcrumbs and tools only.
- **Menu editor upgrades** (`/light/menu`): source picker (Tags / Custom / None), "links shown inline" cap, and a live preview at three widths rendered by the real fold engine.
- **Deployment-injected head markup**: new `HEAD_HTML` / `CSP_SCRIPT_SRC` / `CSP_CONNECT_SRC` config lets a hosting pipeline inject per-instance `<head>` markup (analytics, verification tags) without the open-source engine hardcoding any third-party origin. Empty by default, so the shipped policy and shell are unchanged.
- **Offline password recovery**: new `point reset-password --user=<username> --password=<plaintext>` CLI command resets a user's password directly against the database for operators locked out without SMTP, plus a link to it from the login page.

### Fixed
- **The rendered-page cache is now bounded.** `<STORAGE_PATH>/cache` had no size limit and no eviction: entries were only ever removed wholesale, by a content write, so a blog that publishes rarely accumulated one file per `(page, per_page)` combination its visitors happened to ask for — and `per_page` is fitted to the browser window, so that grew with the audience rather than with the content. It is now capped by `PAGE_CACHE_BUDGET_MB` (default 64), evicting oldest-first once passed, and the requested `per_page` on the public feed and tag archives is snapped down to a fixed ladder of sizes before it reaches a cache key, so nearby window sizes share an entry instead of each rendering their own. Leftover temp files from a write interrupted by a crash are collected by the same sweep.
- **A database missing a core table is no longer initialized over.** `NewRepository` decided a database was new by counting the four core tables and finding fewer than four, so one that had *lost* a table took the fresh-install path: `schema.sql` recreated the missing table empty, both bootstrap migration lists were skipped, and the server booted as if nothing had happened — with no error anywhere. It now separates the two cases by whether the surviving tables hold any rows: an initialization that died part way through is completed with a warning, while a database with data in it refuses to start and points at the recovery script.

### Changed
- **Search runs on an index instead of reading every post.** Search was five leading-wildcard `LIKE`s over post titles, slugs, bodies and tag names — a shape no index can serve, so every search read every post body off disk, in both the admin post list and the public `/search` page. Post text now goes through a SQLite FTS5 index (`posts_fts`, external-content over `posts`, kept current by three triggers and backfilled on the first boot after the upgrade, so no post is duplicated and nothing needs reindexing by hand). At 20k posts, the pair of queries a search page runs (a page of results plus its total) went from 485ms to 1.6ms for a term matching one post, and from 209ms to 9.5ms for one matching 2000; a term that appears in *every* post is the case an inverted index cannot help with and stays about where it was (106ms → 90ms). Two changes to matching come with it: every word in the query must now appear (each matched as a prefix, so a half-typed "cold mou" still finds a cold mountain), and post text no longer matches inside a word — "ountain" no longer finds "mountain". Tag names are still matched as substrings. FTS5 operators typed into the search box (`"`, `*`, `OR`, `NEAR`) are treated as literal text rather than failing the query.
- **Themes page (`/light/themes`) reworked into rows**: each theme is now one horizontal card — palette swatch, name and description, activate button — instead of a tall preview-over-name-over-button stack. The swatch previews the theme's *own* colours (`GET /api/themes` gained `preview_bg` / `preview_surface` / `preview_text` / `preview_border`, read from the theme's light-mode `:root`); previously every swatch was drawn from a single accent plus a dark/light guess, so all of them rendered near-identical. The page's CSS also referenced a retired token vocabulary (`--bg-card`, `--space-4`, `--radius-lg`…), so the cards had had no background, border or shadow at all.
- The site-title hover flyout is no longer a menu surface (it duplicated the now-visible nav links and was unreachable on touch). Child-tag dropdowns on breadcrumbs are unchanged.
- Crumb/nav dropdown items no longer show a "0" count badge for items without post counts (e.g. custom menu links).
- **Login is now a standalone, hard-loaded `/light/login` page** instead of an in-document overlay, so the credential form always loads in a fresh document free of any markup injected via `HEAD_HTML`; logout hard-navigates to drop in-memory admin state. Two HTML shells are now built at serve time — the public shell carries `HEAD_HTML`, the admin shell (and every authenticated request) never does, keeping third-party script out of the admin DOM.

### Security
- **HTML sanitizer URL schemes**: the post content sanitizer now restricts anchor/media URLs to `http`, `https`, and `mailto` (plus relative paths) and enables URL parsing. Previously `javascript:` and `data:text/html` URLs passed through unsanitized — masked by CSP in-browser but a risk in RSS/feed-reader/email contexts. `rel="nofollow"` is now added to links. `data:` is deliberately not allowed (no post content uses `data:` images).
- **CSS sanitizer bypass hardening**: per-post CSS is now stripped of comments and CSS escape sequences (e.g. `\40 import`, `url(/**/https://…)`) are decoded before the denylist runs, closing trivial evasions of the `@import`/external-`url()`/`position`/`z-index`/`content` rules. Full CSS-parser rewrite tracked as follow-up.

### Fixed
- **Admin fixed-viewport layouts never applied**: the posts list and the media library both declare `height: 100dvh; overflow: hidden` on `.light-main` so that only the inner list scrolls and pagination stays on the bottom edge — but `.light-main` is a column flex item whose `flex: 1` (basis `0%`) supersedes `height`, and whose automatic minimum size then pinned it to its content height. Both pages therefore sized to their content and the whole admin page scrolled, leaving the pagination at the bottom of a very long document (and the media grid's viewport-capacity fit measuring a box that grew to whatever it had just loaded). Clearing the two flex defaults on those page variants makes the existing rules take effect.
- **WebAuthn / passkeys**: registration now requires a client-side discoverable (resident-key) credential, so a registered passkey actually has something to offer at login time — usernameless login was silently unable to find any credential before this.

### Fixed
- **Database initialization**: Improved reliability of first-run schema setup by splitting SQL statements and using transactions, fixing an issue where tables could be missing on some environments (e.g. rootless Podman).

## [0.1.0] — initial release

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

[Unreleased]: https://github.com/dariy/point/compare/v0.1.40...HEAD
[0.1.0]: https://github.com/dariy/point/releases/tag/v0.1.0
