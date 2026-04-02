# Plan: Refactor Light Pages to Base Class (Iteration 3)

## Overview
Extract common functionality from the light admin pages (`frontend/src/pages/light/*`) into a shared `LightPage` base class. This plan fixes widespread layout and logic duplication across 8 pages, centralizes core admin features (Sidebar, Logout, Sync Pill, Theme Toggle), and ensures reactive updates for system status.

## Work Units

### Work Unit 1: Create `LightPage` base class
**Scope**: `frontend/src/pages/light/LightPage.js`
**Spec**:
1. Create `LightPage` extending `Component`.
2. Implement `render()` with the full standard admin structure:
   ```html
   <div class="light-layout">
     <div id="sidebar-mount"></div>
     <div class="light-main ${this.getMainClass()}">
       ${this.renderHeader()}
       ${this.renderBanner()}
       <main class="light-content ${this.getContentClass()}">
         ${this.renderPage()}
       </main>
     </div>
   </div>
   ```
3. Implement `renderHeader()`:
   - Renders `<header class="light-header">`.
   - Includes `<h1>${this.getPageTitle()}</h1>`.
   - Includes `this.renderSyncPill()`.
   - Includes `<div class="header-actions">${this.renderHeaderActions()}${this.renderThemeToggle()}</div>`.
4. Provide default/abstract methods:
   - `getPageTitle()`: Abstract.
   - `getSidebarPath()`: Returns `currentPath` (defaults to current URL).
   - `getPublicUrl()`: Returns `publicUrl` (defaults to null).
   - `getMainClass()` / `getContentClass()`: Returns empty strings by default.
   - `renderHeaderActions()`: Returns empty string by default.
   - `renderBanner()`: Returns empty string by default.
   - `renderPage()`: Abstract content.
   - `afterPageRender()`: Hook for subclass logic.
5. Centralize logic:
   - `_handleLogout()`: Common logout handler.
   - `_renderSyncPill(offline)`: Reactive sync pill HTML.
   - `_updateSyncPill()`: DOM update logic for the sync pill.
   - `_handleThemeToggle()`: Theme toggle click handler.
6. Implement `afterRender()` with strict sequencing:
   - 1. Mount `LightSidebar` to `#sidebar-mount`.
   - 2. Bind theme toggle listener.
   - 3. Bind initial sync pill listener.
   - 4. Subscribe to `offline_status` store key and call `_updateSyncPill` on change.
   - 5. Call `this.afterPageRender()`.

**Definition of Done (DoD)**:
- [ ] `LightPage.js` created and exported.
- [ ] `render()` structure matches standard admin layout exactly.
- [ ] `afterRender()` correctly sequences sidebar, listeners, and `afterPageRender`.
- [ ] Sync pill is reactive (subscribes to `offline_status`).

### Work Unit 2: Refactor Pages to inherit `LightPage`
**Scope**: `frontend/src/pages/light/*.js` (DashboardPage, MediaPage, PostEditPage, PostsListPage, SecurityPage, SettingsPage, SystemPage, TagsManagerPage)
**Excluded**: `LoginPage.js` (overlay, no sidebar), `SetupPage.js` (onboarding, no sidebar).
**Spec**:
1. Update each page to `extend LightPage`.
2. Implement `getPageTitle()`, `renderPage()`, and `renderHeaderActions()`.
3. Move page-specific bindings to `afterPageRender()`.
4. Use `getMainClass()` / `getContentClass()` for specific styling (e.g. `PostEditPage`'s `editor-full-width`).
5. Remove all redundant: `_handleLogout`, `LightSidebar` imports/mounting, layout boilerplate.

**Definition of Done (DoD)**:
- [ ] All 8 target pages successfully refactored.
- [ ] App functionality (navigation, logout, theme, sync) verified on all pages.

### Work Unit 3: Cleanup
**Scope**: `frontend/src/components/light/AdminLayout.js`
**Spec**:
1. Delete `AdminLayout.js` (deprecated/unused).

**Definition of Done (DoD)**:
- [ ] `AdminLayout.js` removed.
- [ ] Workspace builds and is free of lint warnings.
