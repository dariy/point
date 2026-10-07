# PRD: Atlas Header Line: Timeline, Breadcrumbs, and Client-Side Tag Navigation

## Overview
Put the breadcrumbs, the timeline, the quick links, and the buttons on one header line:

`<logo> <site_title> → … → <current_tag> ___ <timeline> ___ <quick links> <buttons>`

Example: `. Lab → … → 2025 ___ (2024) _(2025)_ (2026) ___ city country nature other urban [all tags] [map] [search]`

The timeline has two states:
- **Collapsed**: one "All years" pill. The post list has no year filter.
- **Expanded**: one pill for each year. There are no arrows. Pills that are not active are semi-transparent.

A double tap or double click on the timeline toggles between collapsed and expanded. When a year tag is open (for example `/tags/2026`), the timeline is expanded and that year is active. Tag links open client-side: the URL, breadcrumbs, and post list update, and the view mode (list only, map and list, or map only) does not change. A geo tag that the user selects on the home-page map opens as a tag page (`/tags/<geo-tag>`). `atlas-filter-mount` is removed.

## Goals
- One header line on desktop that holds the breadcrumbs, the timeline, the quick links, and the buttons.
- A timeline with two clear states and a double-tap or double-click toggle.
- On year-tag pages, the timeline, URL, breadcrumbs, and post list stay in sync.
- Tag navigation without a full page reload, with the view mode kept.
- The view mode stays the same across navigation (the URL parameter wins, and `localStorage` is the default).
- On narrow screens, the header collapses in a fixed order: the quick links first, then the breadcrumbs, then a burger menu.

## Quality Gates

These commands must pass for every user story:
- `scripts/check.sh`: the full project check (lint, typecheck, unit tests, Go tests)

For UI stories, also include:
- Verify in a browser with the `playwright-cli` skill against the dev server on `:8001` (`scripts/run.sh`), at a desktop width (1440px) and a mobile width (390px).

## User Stories

### US-001: One-line header layout
As a visitor, I want the breadcrumbs, the timeline, the quick links, and the buttons on one header line so that the header uses less vertical space.

**Acceptance Criteria:**
- [ ] The header renders in this order: logo, site title, breadcrumbs, timeline, quick links, buttons (`all tags`, `map`, `search`).
- [ ] The timeline fills the space between the breadcrumbs and the quick links and is centered in that space.
- [ ] At 1440px width with 5 quick links and 3 breadcrumb levels, all elements are on one line (the header height equals one row).
- [ ] The quick links come from the same source as now (the existing top-level tags or nav links). The source does not change.
- [ ] The old separate timeline row and the old header row are removed from the markup and the CSS.
- [ ] CSS changes are made only in the source files under `frontend/css/{light,common,public}/`, then `build-css.sh` is run.

### US-002: Timeline component with collapsed and expanded states
As a visitor, I want the timeline to show either "All years" or one pill for each year so that I can filter by year or see all years.

**Acceptance Criteria:**
- [ ] The collapsed state shows exactly one pill with the text "All years". In this state, the post list has no year filter.
- [ ] The expanded state shows one pill for each year that has posts, in ascending order.
- [ ] The expanded state has no `<` or `>` arrow controls.
- [ ] The active pill is fully opaque. Pills that are not active have reduced opacity (for example `opacity: 0.5`) and become fully opaque on hover or focus.
- [ ] If the pills overflow the space they have, the pill strip scrolls horizontally (touch or wheel) and the active pill scrolls into view.
- [ ] Each pill is a focusable button with `aria-pressed` that shows the active state.
- [ ] Unit tests cover how the component renders in both states.

### US-003: Double tap or double click toggles the timeline state
As a visitor, I want to double tap or double click the timeline to collapse or expand it so that I can switch quickly between "all years" and one year.

**Acceptance Criteria:**
- [ ] A double click (desktop) or double tap (touch, two taps within 300ms) on the timeline toggles collapsed ↔ expanded.
- [ ] Collapsed → expanded: the focus goes to the most recent year (or to the last focused year in this session, if there is one), and the list is filtered by that year.
- [ ] Expanded → collapsed: the year filter is removed. On a year-tag page, navigation goes client-side to the parent of the year tag (the breadcrumb one level up) or to the home page if there is no parent.
- [ ] A single tap does not toggle the state, and a double tap does not also send a single-tap action.
- [ ] A keyboard user can toggle the state with a keyboard shortcut on the focused timeline (Enter on the "All years" pill expands the timeline; Escape collapses it).
- [ ] An e2e test covers the double-click toggle.

### US-004: Single tap on a year pill moves the focus
As a visitor, I want to tap a year pill to move to that year so that I can browse posts year by year.

**Acceptance Criteria:**
- [ ] On a year-tag page (`/tags/<year>`), a tap on another year pill calls `history.pushState` to `/tags/<other-year>`. The breadcrumb leaf changes to `<other-year>` and the post list re-renders with the posts of that year, with no full page reload.
- [ ] On other pages, a tap on a year pill filters the post list in the same way as the current timeline filter. It combines with the geo-tag filter (AND), as in US-007 of the previous epic, and updates the URL query parameters as in US-008.
- [ ] The browser Back and Forward buttons restore the previous year, breadcrumbs, and list (`popstate` handler).
- [ ] An e2e test covers a year change on `/tags/2025` → `/tags/2026` and then Back.

### US-005: Year-tag page opens the timeline in the expanded state
As a visitor, I want the timeline to show the current year when I open a year tag so that I can see where I am.

**Acceptance Criteria:**
- [ ] A direct load of `/tags/2026` renders the timeline expanded, with the `2026` pill active and scrolled into view.
- [ ] Client-side navigation to a year tag (from a breadcrumb, a quick link, or a tag on a post) gives the same state.
- [ ] Navigation to a tag that is not a year tag keeps the current timeline state and filter.
- [ ] The code identifies a year tag with the same rule the server uses (find the existing check; do not add a second definition).

### US-006: Client-side tag navigation that keeps the view mode
As a visitor, I want tag links to update the content in place so that my map or list view does not reset.

**Acceptance Criteria:**
- [ ] A click on a tag link (a breadcrumb, a quick link, a tag on a post, an `all tags` entry) is intercepted. It calls `history.pushState` to the tag URL, gets the content, and replaces only the breadcrumbs, the timeline state, the post list, and the map data.
- [ ] The view mode (list only, map and list, map only) is the same before and after the navigation.
- [ ] Modified clicks (Ctrl/Cmd/Shift/middle click) are not intercepted and keep the browser default.
- [ ] `document.title` updates to the title of the new tag page.
- [ ] If the fetch fails, the code falls back to a full page navigation to the same URL.
- [ ] `popstate` restores the previous tag content without a reload.
- [ ] An e2e test opens map-only mode, clicks a tag link, and checks that the map-only mode stays and the breadcrumb leaf is the new tag.

### US-007: View mode saved in the URL and localStorage
As a visitor, I want my view mode to persist and to be shareable so that links open in the view I chose.

**Acceptance Criteria:**
- [ ] The view mode is in a URL query parameter `view` with the values `list`, `split`, and `map`, next to the US-008 filter parameters.
- [ ] Each change of the view mode writes it to `localStorage` and to the URL (with `history.replaceState`).
- [ ] On page load, the order of priority is: the `view` URL parameter, then the `localStorage` value, then the current default.
- [ ] An invalid `view` value is ignored and the code uses the next source.
- [ ] Client-side tag navigation (US-006) keeps the `view` parameter in the new URL.
- [ ] Unit tests cover the priority order.

### US-008: Home-page map geo-tag selection opens the tag page
As a visitor, I want a geo tag that I select on the home-page map to show in the breadcrumbs so that it behaves the same as when I open the tag link.

**Acceptance Criteria:**
- [ ] When the user selects a geo tag on the home-page map, the code does client-side navigation (US-006) to `/tags/<geo-tag>`. The breadcrumbs show the geo tag as the leaf.
- [ ] `atlas-filter-mount` and its code, CSS, and tests are removed.
- [ ] The view mode and the timeline year filter stay the same after the navigation.
- [ ] When the user clears the selection on the map, navigation goes back to the home page (`pushState` to `/`, with the same view and year parameters).
- [ ] The existing atlas e2e tests (`frontend/e2e/atlas-*.test.ts`) are updated to the new behavior and pass.

### US-009: Responsive header collapse
As a mobile visitor, I want the header to collapse in a predictable order so that it stays on one line on narrow screens.

**Acceptance Criteria:**
- [ ] When the header does not fit on one line, the quick links are hidden first.
- [ ] If the header still does not fit, the breadcrumbs collapse to `… → <leaf>`.
- [ ] If the header still does not fit, the quick links and the buttons move into a burger button at the right edge of the header. The burger opens a menu that holds them.
- [ ] The timeline stays visible at all widths down to 320px.
- [ ] The collapse responds to the space the header actually has (`ResizeObserver` or container queries), not only to fixed breakpoints.
- [ ] The burger menu closes on Escape, on an outside click, and after navigation. It has `aria-expanded` and `aria-controls`.
- [ ] Browser verification at 1440px, 1024px, 768px, 390px, and 320px shows each collapse step as specified.

## Functional Requirements
- FR-1: The header must render the logo, site title, breadcrumbs, timeline, quick links, and buttons on one line when there is enough space.
- FR-2: The timeline must have exactly two states: collapsed ("All years", no year filter) and expanded (one pill for each year).
- FR-3: A double tap or double click on the timeline must toggle the state. A single tap must not toggle it.
- FR-4: The timeline must not render arrow controls. Pills that are not active must have reduced opacity.
- FR-5: On `/tags/<year>`, the timeline must be expanded and the pill for `<year>` must be active.
- FR-6: On a year-tag page, a change of the focused year must update the URL (`pushState`), the breadcrumb leaf, and the post list without a reload.
- FR-7: On other pages, the year pill must filter the list and combine with the geo-tag filter (AND).
- FR-8: Tag links must navigate client-side and keep the view mode. Modified clicks and fetch failures must use normal navigation.
- FR-9: The view mode must be read from `?view=`, then `localStorage`, then the default, and written to both.
- FR-10: A geo-tag selection on the home-page map must navigate to `/tags/<geo-tag>`. `atlas-filter-mount` must be removed.
- FR-11: The header must collapse in this order: quick links, then breadcrumbs (to the leaf), then quick links and buttons into a burger menu at the right.
- FR-12: Back and Forward must restore the tag, year, breadcrumbs, list, and map data.

## Non-Goals
- No change to how the quick links are sourced or configured. There is no new admin setting.
- No month-level or range selection in the timeline.
- No arrow controls in the timeline.
- No server-side rendering changes beyond what the client fetch needs (reuse the existing tag page or API responses).
- No changes to the map clustering or the map tile behavior.
- No work on the `carousel-studio` branch.

## Technical Considerations
- Relevant code: `frontend/src/plugins/tags-atlas/` (`atlasLayerGesture.ts` and the atlas layer modules), `frontend/src/core/gridPager.ts`, `frontend/src/utils/gridFit.ts`, `frontend/css/public/atlas.css`, and the e2e tests `frontend/e2e/atlas-layer*.test.ts`.
- Reuse the URL filter-parameter code from the previous epic (p-atlas-layer-p2-rwea US-008) for `view` and the year.
- Reuse the existing timeline filter logic (US-007 of the previous epic) for the AND combination with the geo-tag filter.
- Client-side navigation needs one router module (intercept, fetch, swap, `popstate`) that US-004, US-006, and US-008 share. Build it in US-006 first. Recommended order: US-001 → US-002 → US-006 → US-007 → US-005 → US-004 → US-003 → US-008 → US-009.
- Double-tap detection must not conflict with the existing atlas gestures in `atlasLayerGesture.ts`.
- Edit the CSS source files only, then run `build-css.sh`. Do not edit the generated bundles.
- The frontend does not use a dev-server restart in `--watch` mode. Otherwise, run `scripts/run.sh` again after a JS or CSS change.

## Success Metrics
- At 1440px, the header is one row, and the old timeline row no longer exists.
- Tag navigation causes zero full page reloads (examine with the Playwright network log) and keeps the view mode in 100% of the e2e cases.
- On year-tag pages, the URL, breadcrumb leaf, active pill, and list always agree (e2e test assertions).
- All `frontend/e2e/atlas-*.test.ts` tests and `scripts/check.sh` pass.

## Open Questions
- When the user collapses the timeline on a year-tag page, must the navigation go to the parent tag or to the home page? (This PRD assumes the parent if one exists, else the home page.)
- Which year gets the focus when the user expands the timeline from "All years" on a page that is not a year tag: the most recent year, or the last focused year? (This PRD assumes the last focused year in this session, else the most recent.)
- Must the burger menu also hold the collapsed breadcrumb levels, or only the quick links and the buttons?