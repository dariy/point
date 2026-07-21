# Themes

This directory contains the built-in themes for the Point blog. Each theme is a
plain CSS file, scanned at runtime by `ThemeService` (`api/internal/services/theme_service.go`).

User-supplied themes live in a separate directory (`USER_THEMES_PATH`) and, name
for name, override the built-ins.

## Theme File Structure

A theme is a single `<name>.css` file:

- A `:root { ... }` block of CSS custom properties for light mode (the default).
- An optional `[data-theme="dark"] { ... }` block overriding those properties for
  dark mode. Its mere presence marks the theme as dark-mode-capable
  (`ThemeService.HasDarkMode`, cached until restart).
- Three metadata comments read by `ThemeService` to populate the theme picker:
  - `/* theme-title: "..." */`
  - `/* description: "..." */`
  - `/* preview-color: "..." */`

### Example

```css
/* theme-title: "Example" */
/* description: "A short description shown in the theme picker." */
/* preview-color: "#2563eb" */

:root {
  --bg-primary: #ffffff;
  --text-primary: #0f172a;
  --color-primary: #2563eb;
  --border-primary: #e2e8f0;
}

[data-theme="dark"] {
  --bg-primary: #0f172a;
  --text-primary: #f1f5f9;
}
```

Variables are plain CSS custom properties (no `--pt-` prefix) — see any built-in
theme for the full variable set (`--bg-*`, `--text-*`, `--color-*`, `--surface-*`,
`--border-*`, ...).

## Built-in Themes

- `default.css` — the standard Point experience: clean, modern, blue accent.
- `base.css` — bare, neutral canvas (grayscale, system fonts) that stays out of
  the way so per-post CSS can turn a post into its own micro-site.
- `golden.css`, `minimal.css`, `ocean.css`, `sepia.css` — additional built-in
  palettes.

## How Themes Are Applied

`ThemeService` reads the active theme's CSS file server-side and serves it
(merged with any admin-configured overrides) to the frontend, which applies it
by setting `data-theme` on the document root. See
[docs/features/themes.md](../../docs/features/themes.md) for the full pipeline.
