# Theme System Design
**Date:** 2026-04-23
**Issue:** point-y1d
**Status:** Approved

## Overview

A theme system for the Point photo blog. Themes contain CSS (required) and optionally dark-mode CSS overrides and a JS file for PointBus integrations. The admin selects the active theme in `/light/themes`. Visitors see the chosen theme; their browser's system preference determines light vs dark mode automatically, with a manual toggle override saved to localStorage.

Built-in themes ship in `frontend/themes/`. User-added themes live in `data/themes/` (the mounted runtime volume). The active theme is stored in `blog_settings` as `active_theme`.

---

## Theme File Format

A theme is a named folder. The folder name is the theme ID (used in URLs and the database).

```
themes/{id}/
  manifest.json      ← required
  theme.css          ← required (light mode CSS vars + overrides)
  theme-dark.css     ← optional (dark mode overrides)
  theme.js           ← optional (PointBus integrations, no DOM manipulation)
  preview.jpg        ← optional (card thumbnail; .png also accepted)
```

### `manifest.json`

Required fields: `name` (string), `version` (string).
Optional fields: `description` (string), `author` (string).

```json
{
  "name": "Minimal",
  "version": "1.0.0",
  "description": "Clean, high-contrast, distraction-free.",
  "author": "Point"
}
```

### `theme.css` convention

Overrides the semantic CSS vars defined in `frontend/css/public/tokens.css`. Only redefine what the theme changes — missing vars fall back to `:root` defaults.

```css
:root, [data-theme="light"] {
  --font-family: system-ui, sans-serif;
  --color-primary: #111111;
  --bg-primary: #ffffff;
}
```

### `theme-dark.css` convention

Overrides `[data-theme="dark"]` vars. Injected as a second stylesheet, applied when dark mode is active.

### `theme.js` contract

Receives `window.Point` (PointBus + event constants). Must not block the main thread. Must use `window.Point.events` constants — no hardcoded event name strings.

```js
(function() {
  window.Point.on(window.Point.events.APP_READY, () => {
    // custom behavior
  });
})();
```

### Validation rules

A theme folder passes validation if:
1. `manifest.json` exists, parses as valid JSON, and contains `name` and `version` fields
2. `theme.css` exists

Invalid folders are silently skipped (logged at debug level). Themes are not re-validated on every request — validation runs at listing time.

### Exclusion by convention

Any theme folder whose name starts with `example` is excluded from the listing entirely. The documented example theme lives at `frontend/themes/example/` and is never shown in the picker.

---

## CSS Var Coverage Prerequisite

Before any theme CSS is written, a one-time audit of all `frontend/css/` files replaces hardcoded color, font, and spacing values with the semantic vars already defined in `tokens.css` (or new vars added there). This is what makes themes actually work — a theme can only control what's behind a CSS var.

---

## Backend (Go)

### File serving

```
GET /themes/{name}/*
```

No auth required. Checks `frontend/themes/{name}/` first (built-in), then `data/themes/{name}/` (user). Returns 404 if neither exists.

Also serves the shared preview template:
```
GET /themes/_preview.html
```

### Theme listing

```
GET /api/themes    ← requires admin auth
```

Scans `frontend/themes/` and `data/themes/`. Excludes folders starting with `example`. Validates each. Returns combined list:

```json
[
  {
    "id": "default",
    "name": "Default",
    "description": "The standard Point design.",
    "author": "Point",
    "version": "1.0.0",
    "is_builtin": true,
    "has_dark": true,
    "has_js": false,
    "preview_url": "/themes/default/preview.jpg",
    "is_active": true
  }
]
```

`preview_url` is `/themes/{id}/preview.jpg` or `/themes/{id}/preview.png` (whichever exists), or empty string if neither found.

### Set active theme

```
PUT /api/themes/active    ← requires admin auth
Body: { "theme_id": "minimal" }
```

Validates the theme exists and passes validation before writing to `blog_settings`. Returns 400 if invalid.

### Active theme in settings

`GET /api/settings` already returns all `blog_settings` rows. `active_theme` appears there automatically — no new GET endpoint needed.

### New files

```
api/internal/services/theme_service.go   ← scan, validate, list, serve
api/internal/api/themes.go               ← handlers for GET /api/themes, PUT /api/themes/active
```

Routes registered in `cmd/api/main.go`. Theme service receives `storagePath` and `frontendDir` from the existing config.

---

## Frontend

### Theme loading (`themeLoader.js`)

Replaces `themeParser.js`. Called in `app.js` after settings are fetched:

```js
import { loadTheme } from './utils/themeLoader.js';
await loadTheme(store.getState().settings.active_theme ?? 'default');
```

Responsibilities:
1. Inject `<link id="pt-theme-css" href="/themes/{id}/theme.css">` into `<head>`
2. Detect system `prefers-color-scheme` → set `data-theme` on `<html>`
3. Check localStorage for saved user preference → override system default
4. Always inject `<link id="pt-theme-dark-css" href="/themes/{id}/theme-dark.css">` — browsers handle 404 on stylesheets silently, no existence check needed
5. HEAD-fetch `/themes/{id}/theme.js` to check existence; if 200, inject `<script>` after PointBus is initialized. Avoids console errors from 404 script tags.
6. Emit `window.Point.events.THEME_CHANGED` on mode switches

### PointBus event constants

`PointBus.js` exports `PointEvents` and attaches to `window.Point.events`:

```js
export const PointEvents = {
  APP_READY: 'app:ready',
  THEME_CHANGED: 'theme:changed',
  LIGHTBOX_OPEN: 'lightbox:open',
  LIGHTBOX_CLOSE: 'lightbox:close',
  LIGHTBOX_SWIPE: 'lightbox:swipe',
};
```

### `/light/themes` page

New file: `frontend/src/pages/light/ThemesPage.js`

Card grid layout. One card per theme:
- **Preview area:** `preview.jpg` / `preview.png` as thumbnail; if absent, full-card block showing the first letter of the theme name centered on a muted neutral background (consistent across all placeholders — the letter is the differentiator)
- **Info:** name, description, author + version (muted)
- **Badges:** `dark mode`, `custom JS`, `user theme` (if not built-in)
- **Active indicator:** highlighted border on active theme card
- **Activate button:** inactive themes show an Activate button; swaps theme CSS in-place (no page reload), updates `data-theme` state, saves to DB

Click on preview area → modal with sandboxed `<iframe>` loading `_preview.html?theme={id}`. No JS runs inside the preview (iframe sandbox attribute).

### Preview template (`frontend/themes/_preview.html`)

Static HTML file. Reads `?theme` query param, injects `<link>` for `theme.css` and conditionally `theme-dark.css`. Contains sample content: header, post card grid, footer, a code block, a blockquote. Represents what a real visitor sees. No theme JS loaded.

### New/modified files

```
frontend/src/utils/themeLoader.js              ← new (replaces themeParser.js)
frontend/src/pages/light/ThemesPage.js         ← new
frontend/src/api/themes.js                     ← new
frontend/src/utils/PointBus.js                 ← add PointEvents constants + window.Point.events
frontend/src/app.js                            ← call themeLoader, remove themeParser
frontend/src/router.js                         ← add /light/themes route
frontend/src/components/light/LightSidebar.js  ← add Themes nav link

frontend/themes/_preview.html                  ← new (shared preview template)
frontend/themes/example/manifest.json          ← new
frontend/themes/example/theme.css              ← new (all vars, fully commented)
frontend/themes/example/theme-dark.css         ← new
frontend/themes/example/theme.js               ← new (all events as stubs)
frontend/themes/example/README.md              ← new (plain English guide)

frontend/themes/default/manifest.json          ← new
frontend/themes/default/theme.css              ← new (extracted from tokens.css)
frontend/themes/default/theme-dark.css         ← new
frontend/themes/default/preview.jpg            ← new

frontend/themes/minimal/manifest.json          ← new
frontend/themes/minimal/theme.css              ← new
frontend/themes/minimal/theme-dark.css         ← new
frontend/themes/minimal/preview.jpg            ← new

frontend/themes/sepia/manifest.json            ← new
frontend/themes/sepia/theme.css                ← new
frontend/themes/sepia/theme-dark.css           ← new
frontend/themes/sepia/preview.jpg              ← new
```

---

## 3 Built-in Themes

### `default`
Extracted directly from the existing `tokens.css`. No visual change — the reference baseline. Blue primary (`#2563eb`), Inter font, card shadows, white light / near-black dark mode.

### `minimal`
System fonts (`system-ui`). Near-black `#111` on white `#fff`. No colored accents — interactive elements use dark text + underline. No card shadows, thin `1px` borders only. Generous whitespace. Dark: `#f0f0f0` on `#0a0a0a`. Goal: photography-first, nothing competes with images.

### `sepia`
Georgia serif body, `system-ui` for UI chrome. Light: warm off-white `#f5f0e8` background, dark brown `#2c1a0e` text, amber `#c17f24` accent. Dark: deep warm `#1a1008` background, pale cream `#e8dcc8` text. Warm-gray borders, warm-tinted shadows. Goal: printed photo book feeling.

All three ship with `theme.css`, `theme-dark.css`, and `preview.jpg`. No `theme.js`.

---

## Documented Example Theme

`frontend/themes/example/` is the copy-paste starting point for user themes. Excluded from the picker by folder name convention. Users copy it to `data/themes/my-theme/` and customize.

- `manifest.json` — annotated with every supported field
- `theme.css` — every CSS var on its own line with inline comment explaining what it controls
- `theme-dark.css` — same structure
- `theme.js` — one real PointBus example + all other events as commented stubs
- `README.md` — plain English: folder naming rules (lowercase, hyphens, no `example` prefix), required files, validation, activation in `/light/themes`, JS sandbox contract

---

## Data Flow Summary

```
Admin visits /light/themes
  → GET /api/themes → theme list with metadata
  → Card grid rendered
  → Click preview → iframe loads _preview.html?theme={id} (sandboxed, no JS)
  → Click Activate → PUT /api/themes/active → blog_settings updated
  → themeLoader swaps <link> href in-place → theme changes without reload

Visitor loads page
  → GET /api/settings → active_theme returned
  → themeLoader injects theme CSS, detects system preference
  → data-theme set on <html>
  → theme.js injected (if has_js) after PointBus ready
```
