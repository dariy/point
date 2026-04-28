# CSS Themes System Implementation Plan

> **Note on Two-Stage Rollout:**
> 1. **Stage 1 (MVP):** CSS-only themes using a JSON-based variable injection system. Focuses on color palettes and typography.
> 2. **Stage 2 (Future):** Support for custom HTML templates and JavaScript logic per theme.

**Goal:** Add multi-theme support to Point — pre-defined themes with light/dark modes, custom theme folder scanning and validation, an admin Themes page, and a public mode toggle wired to each theme's color palettes.

**Architecture:** The backend `ThemeService` scans two directories (`{FrontendDir}/themes/` for built-in themes and an optional `THEMES_PATH` for custom ones), validates each `theme.json` against a required schema, and exposes three API endpoints. The frontend `themeParser.js` fetches the active theme from the API and injects CSS variables into `:root` (mapping them to existing variables like `--bg-primary` and `--text-primary`); it caches the theme in `localStorage` to eliminate FOUC on reload. The admin `ThemesPage` lists all valid themes and lets the admin activate one.

**Tech Stack:** Go 1.25 + Echo v4 (backend), vanilla JS ES6+ (frontend), SQLite `blog_settings` table (active theme persistence).

---

## Stage 1: MVP (CSS-only)

### Task 1: Built-in theme JSON files
- Create: `frontend/themes/default/theme.json`, `frontend/themes/ocean/theme.json`, `frontend/themes/minimal/theme.json`
- Create: `frontend/themes/example/theme.json` & `README.md`
- [ ] **Step 1:** Use Gemini CLI to research accessible, aesthetically distinct color palettes (Default, Ocean, Minimal).
- [ ] **Step 2:** Create the directory structure and write the `theme.json` files. Ensure they include `name`, `version`, `light`, and `dark` sections with `colors`, `spacing`, and `typography`.

### Task 2: Backend ThemeService & API
- Modify: `api/internal/config/config.go` (Add `ThemesPath`)
- Create: `api/internal/services/theme_service.go` & `_test.go`
- Create: `api/internal/api/themes.go` & `_test.go`
- [ ] **Step 1:** Implement `ThemeService` with `ScanThemes`, `GetActiveTheme`, and `SetActiveTheme`.
- [ ] **Step 2:** Robust Validation: `validateTheme` must check for required fields (`colors.bg`, `colors.text`, `colors.accent`) in both light and dark sections.
- [ ] **Step 3:** Edge Case Handling: `GetActiveTheme` should fallback to "default" if the active theme is missing or invalid on disk.
- [ ] **Step 4:** Implement Echo handlers and register routes in `main.go`.

### Task 3: Frontend Utils & API Client
- Modify: `frontend/src/utils/themeParser.js`
- Create: `frontend/src/api/themes.js`
- [ ] **Step 1:** Rewrite `themeParser.js` to map theme JSON variables to EXISTING blog variables (e.g., `colors.bg` -> `--bg-primary`, `colors.text` -> `--text-primary`).
- [ ] **Step 2:** Implement `applyTheme` to inject `:root` styles and `loadAndApplyTheme` to fetch from API.
- [ ] **Step 3:** Update `frontend/test/themeParser.test.js` to verify variable mapping and fallback logic.

### Task 4: Admin UI & Integration
- Create: `frontend/src/pages/light/ThemesPage.js`
- Modify: `frontend/src/components/light/LightSidebar.js`
- Modify: `frontend/src/pages/light/SettingsPage.js` (Add link to Themes)
- Modify: `frontend/src/app.js` (Route registration and initialization)
- [ ] **Step 1:** Implement `ThemesPage.js` with theme grid, swatches, and activation logic.
- [ ] **Step 2:** Add "Themes" to the admin sidebar.
- [ ] **Step 3:** **Navigation Parity:** Add a prominent "Theme Settings" link or button in the existing `SettingsPage.js`.
- [ ] **Step 4:** Ensure `app.js` re-applies the theme when the user toggles light/dark mode.

### Task 5: CSS & Build
- Create: `frontend/css/light/themes.css`
- Modify: `frontend/css/common/theme-toggle.css` (Explicit `auto` mode support)
- Modify: `scripts/build-css.sh`
- [ ] **Step 1:** Write styles for the admin Themes UI.
- [ ] **Step 2:** **E2E Verification:** Add a manual verification step in the script to confirm the public blog correctly reflects color changes when switching themes.

---

## Stage 2: HTML & JS Support (Future)

- **Requirement:** Allow themes to override HTML structure and include custom JS logic.
- **Approach:**
    - Backend: `ThemeService` will scan for `index.html` (partial) and `scripts.js` in theme folders.
    - Frontend: `app.js` or a new `TemplateLoader` will fetch these assets and inject them into specific mount points or head.
    - Isolation: Ensure custom scripts are loaded with `defer` and don't break core event listeners (Passive Listeners mandate).
