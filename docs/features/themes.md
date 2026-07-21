# Themes

Several built-in CSS themes, user-supplied custom themes, and dark/light/auto modes,
owned by `ThemeService` (`api/internal/services/theme_service.go`).

## What is implemented

- **Themes are plain CSS files** declaring CSS custom properties. Built-in themes live
  in `frontend/themes/*.css` (`base`, `default`, `golden`, `minimal`, `ocean`,
  `sepia`); user themes live under the data dir (`UserThemesPath`). Lookup priority:
  **user path first, then system path** — a user theme can shadow a built-in by name.
- **Activation syncs a public file**: setting the active theme writes the merged result
  to `<FrontendDir>/css/common/theme.css`, served as
  `/assets/css/common/theme.css` — one static file, no per-request theming cost.
  (That file is generated — never edit it; see `scripts/build-css.sh` rules.)
- **Modes**: light / dark / auto (`prefers-color-scheme`), with a visitor-facing
  toggle persisted in localStorage overriding auto. Theme CSS targets
  `[data-theme="light"|"dark"]`; the server detects whether the active theme has a
  dark variant by the presence of `[data-theme="dark"]` rules (cached in
  `ThemeService.darkModeCache` until restart).
- **Admin**: `/light/themes` (ThemesPage) lists, previews, and activates themes; blog
  title/description are separate Settings reflected in the public UI and RSS.
- **MCP**: `point_list_themes`, `point_get_theme_css`, `point_set_active_theme` allow
  AI-driven theme work.
- Every color/spacing token is a CSS custom property (`frontend/css/common/tokens.css`),
  so per-site tweaks are surgical overrides.

## Key decisions

- **CSS files, not JSON.** An earlier design defined themes as JSON token maps
  (`light`/`dark`/`shared` → generated `--pt-*` properties). It was replaced by raw
  CSS: themes routinely need selectors and media queries, not just token values, and a
  CSS file is directly editable/inspectable. If you find references to JSON themes
  (e.g. an old `frontend/themes/README.md`), they describe the retired format.
- **Serve-time static file over runtime injection** — the active theme is compiled
  once on activation, keeping the request path zero-cost and the SW/PWA caching story
  simple.
- Dark-mode capability is **detected, not declared** — no theme metadata to keep in
  sync with the CSS.

## Notes for future development

- After changing theme resolution or the active theme file location, remember the
  cache: `darkModeCache` persists until restart.
- Per-post CSS and global custom CSS are separate features (see
  [publishing.md](publishing.md)) layered on top of the theme.
