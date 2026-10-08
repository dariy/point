# PRD: Atlas Layer Redesign, Part 2 (Timeline, Footer, Handle, Map Filter, List Pagination)

## Overview
This PRD continues the Atlas + post list redesign on the `atlas-sheet` branch (epic `p-atlas-layer-1qus`). It does seven things:

- The atlas layer starts below the timeline when the timeline plugin is on.
- A minimized footer shows in the map-only state.
- The handle has two maximize buttons in the map+list state.
- The handle can be dragged anywhere along the container and snaps to one of three states on release.
- The map behavior from before the redesign comes back.
- The map filter and the timeline filter apply together to the post list and are written to the URL.
- A bug is fixed: the map+list list shows only one image.

## Goals
- When the timeline plugin is on, the timeline stays fixed at the top, the same as the header. The atlas layer fills the area below it.
- The map-only state has the largest possible map area on all widths and clears the system UI at the bottom of mobile screens.
- The user can change the state with one tap on a handle button or with a free drag that snaps to a state.
- The map works as it did on `develop` before the atlas-sheet commits: country shapes, selectable geo-tags, and the tag-post graph.
- The geo-tag filter and the timeline filter combine with AND, and both are kept in the URL.
- The map+list list shows the same post collection as list-only, with the same first visible post.

## Quality Gates

These commands must pass for every user story:
- `scripts/check.sh` - lint, type check, unit and integration tests

For UI stories, also include:
- Verify in a browser with playwright-cli on the dev server (`scripts/run.sh`, port 8001) at mobile (390×844) and tablet (820×1180) sizes

## User Stories

### US-001: Atlas layer below the timeline
As a visitor, I want the map to open below the timeline when the timeline plugin is on, so that the timeline stays visible and usable, the same as the header.

**Acceptance Criteria:**
- [ ] When the timeline plugin is enabled, the top edge of the atlas layer container is at the bottom edge of the timeline. The timeline does not overlap the map or the handle.
- [ ] The timeline stays fixed at the top in all three states (list-only, map+list, map-only).
- [ ] When the timeline plugin is disabled, the layout is the same as before this story: the container starts below the header.
- [ ] `atlasLayerLayout.ts` gets the top offset from the measured bottom of the header and the timeline (ResizeObserver or the same mechanism the header uses), not from a hard-coded value.
- [ ] A Playwright test in `frontend/e2e/atlas-layer-header.test.ts` (or a new `atlas-layer-timeline.test.ts`) asserts that the top of the container is at or below the bottom of the timeline when the timeline is enabled.

### US-002: Minimized footer in the map-only state
As a mobile visitor, I want a compact footer under the handle in the map-only state, so that the handle clears the system UI and the map gets more space.

**Acceptance Criteria:**
- [ ] In the map-only state, at all widths, the footer is between the handle and the bottom of the viewport.
- [ ] The minimized footer shows only the copyright text, with minimal vertical padding. Links and other footer content are hidden.
- [ ] In the list-only and map+list states, the normal footer shows without changes.
- [ ] When the public-footer plugin is disabled, the handle in the map-only state sits at the bottom of the page and no footer space is reserved.
- [ ] The minimized footer uses `padding-bottom: env(safe-area-inset-bottom)` so that its text clears the system UI.
- [ ] The CSS changes are in `frontend/css/public/footer.css` and/or `frontend/css/public/atlas.css`, and the bundle is rebuilt with `build-css.sh`. Generated bundles are not edited.
- [ ] A Playwright test asserts that the minimized footer shows only in the map-only state and that the handle is at the bottom of the page when the footer plugin is off.

### US-003: Two maximize buttons on the handle
As a visitor, I want two buttons on the handle in the map+list state, so that one tap opens the full map or the full list.

**Acceptance Criteria:**
- [ ] In the map+list state, `atlasLayerHandle.ts` shows two buttons: "Maximize map" (changes to map-only) and "Maximize list" (changes to list-only).
- [ ] In the map-only and list-only states, the handle shows one button that restores map+list.
- [ ] Each button has an `aria-label`, can be reached with the keyboard, and has a touch target of at least 44×44 px.
- [ ] A tap on a button does not start a drag gesture.
- [ ] A Playwright test in `frontend/e2e/atlas-layer-gesture.test.ts` covers each button and the state that results.

### US-004: Free drag with snap to three positions
As a visitor, I want to drag the handle along the full container and have it snap to a state when I release it, so that I can see the map and the list change while I drag.

**Acceptance Criteria:**
- [ ] The handle can be dragged continuously from the bottom of the header (or timeline) to the top of the footer, or to the bottom of the page if the footer is off.
- [ ] During the drag, both regions stay rendered. The map is visible above the handle and the list is visible below it, and they resize live.
- [ ] On release, the handle snaps to the nearest of the three positions: list-only, map+list, or map-only. A fast flick moves to the next position in the flick direction.
- [ ] The snap animation is disabled when `prefers-reduced-motion: reduce` is set.
- [ ] The existing map-first gesture priority in `atlasLayerGesture.ts` is kept: a pan inside the map does not move the handle.
- [ ] Unit tests for the snap logic (nearest position, flick threshold) are added to `frontend/test/`.
- [ ] A Playwright test drags the handle to points near each position and asserts the state after each release.

### US-005: Restore the map behavior from before the redesign
As a visitor, I want the map to show country shapes and selectable geo-tags with the tag-post graph, as it did before the redesign.

**Acceptance Criteria:**
- [ ] The reference is the `develop` branch before the atlas-sheet commits. The country shape, geo-tag selection and tag-post graph modules from that version are reused without behavior changes.
- [ ] `atlasLayerMap.ts` mounts those modules in the atlas layer map region.
- [ ] Countries that have tags render as filled shapes.
- [ ] Every geo-tag can be selected. When a geo-tag is selected, the tag-post graph shows for it.
- [ ] The map resizes correctly in all three states and during a drag (call `invalidateSize` or the equivalent when the region changes size).
- [ ] The tests in `frontend/e2e/atlas-layer-map.test.ts` cover the country shapes, geo-tag selection and the graph.

### US-006: Geo-tag selection filters the post list
As a visitor, I want the selected geo-tag to filter the post list, so that I see only the posts for that place.

**Acceptance Criteria:**
- [ ] When a geo-tag is selected on the map, the list shows only the posts with that tag.
- [ ] When the selection is cleared, the unfiltered collection comes back.
- [ ] The filter applies in the map+list and list-only states.
- [ ] The list shows the active filter as a removable chip or label.
- [ ] A Playwright test selects a geo-tag and asserts that every post in the list has that tag.

### US-007: Timeline filter combined with the geo-tag filter (AND)
As a visitor, I want the timeline to filter the post list together with the map, so that I can see posts from one place in one time range.

**Acceptance Criteria:**
- [ ] When a time range is selected on the timeline, the list in the atlas layer shows only the posts in that range.
- [ ] When both filters are active, the list shows posts that match the geo-tag AND the time range.
- [ ] Each filter can be cleared on its own.
- [ ] One shared filter state module combines the two filters. The map and the timeline do not query the list independently.
- [ ] Unit tests cover each filter alone, both filters together, and clearing each one.

### US-008: Filters in URL query parameters
As a visitor, I want the filters in the URL, so that I can share or reload a filtered view.

**Acceptance Criteria:**
- [ ] The geo-tag filter and the timeline range are written to URL query parameters with `history.replaceState`. The names follow the conventions already used in `atlasLayerState.ts`.
- [ ] When the page loads with these parameters, the filters, the map selection and the timeline selection are restored.
- [ ] The atlas state parameter that already exists continues to work with the filter parameters.
- [ ] Invalid parameter values are ignored without an error.
- [ ] `frontend/e2e/atlas-layer-url.test.ts` covers reload and deep links with filters.

### US-009: Fix the map+list list (same collection, adaptive page size, same first post)
As a visitor, I want the map+list list to show the same posts as list-only, so that I do not lose my place when I change state.

**Acceptance Criteria:**
- [ ] Bug fixed: on the home page, map+list shows several posts, not one image.
- [ ] list-only and map+list use the same post collection (the same query, tag and filters).
- [ ] The page size can differ between states and is calculated from the available list height. Example: for the tag "mountains", list-only shows 6 posts and map+list shows 8 posts from the same collection.
- [ ] When the state changes, the first visible post is the same as before the change.
- [ ] The list area scrolls in map+list and loads more posts from the same collection.
- [ ] A Playwright test on the home page asserts more than one post in map+list. It also asserts that the first visible post is the same after list-only → map+list → list-only.

## Functional Requirements
- FR-1: When the timeline plugin is enabled, the atlas layer container must start at the bottom edge of the timeline.
- FR-2: The minimized footer (copyright only, minimal padding) must show only in the map-only state, at all widths.
- FR-3: When the public-footer plugin is disabled, the handle in map-only must sit at the bottom of the page.
- FR-4: In map+list, the handle must show the "Maximize map" and "Maximize list" buttons. In the other states, it must show one "restore map+list" button.
- FR-5: The handle must be draggable along the full container, and it must snap to list-only, map+list or map-only on release.
- FR-6: During a drag, both regions must stay rendered and resize live.
- FR-7: The map must render country shapes, selectable geo-tags and the tag-post graph, the same as on `develop` before the atlas-sheet commits.
- FR-8: The geo-tag filter and the timeline filter must combine with AND on the post list.
- FR-9: The filters must be kept in URL query parameters and restored on load.
- FR-10: list-only and map+list must use the same collection. The page size may differ, and the first visible post must stay the same across a state change.

## Non-Goals
- The handle position is not kept in sessionStorage. The URL state parameter is the only persistence.
- No new map features beyond the behavior from before the redesign.
- No changes to the timeline plugin itself, other than its filter output.
- No change to the desktop footer outside the map-only state.
- No changes to the Carousel Studio work.

## Technical Considerations
- Main modules: `frontend/src/plugins/tags-atlas/{AtlasSheet,atlasLayerLayout,atlasLayerHandle,atlasLayerGesture,atlasLayerMap,atlasLayerState}.ts`, `frontend/src/plugins/timeline/index.ts`, `frontend/src/plugins/public-footer/PublicFooter.ts`.
- CSS: edit only `frontend/css/public/{atlas,footer,timeline}.css`, then run `build-css.sh`.
- Get the earlier map modules with `git log develop -- frontend/src/plugins/tags-atlas` from before commit `59c75cee`'s parent chain (the atlas-sheet commits).
- To keep the first visible post, use its post id as an anchor and do not use an offset. Load the page that contains the anchor, then scroll to it.
- The timeline filter can need a server-side query (`api/internal/api/timeline.go`). If the posts API cannot take a tag and a date range at the same time, add that support in US-007.
- Target branch for PRs: `atlas-sheet`, the epic branch.

## Success Metrics
- All new and existing Playwright atlas tests pass at 390×844 and 820×1180.
- In map+list, the home page shows the same number of posts as the list height allows. It never shows only one.
- A filtered URL reloads to the same map selection, timeline range and list.
- In map-only, the map region on a 390×844 viewport is taller than it was before this work.

## Open Questions
- What are the exact snap thresholds for drag release (nearest position, or fixed bands such as 0–25%, 25–75%, 75–100%)? And what flick velocity triggers a move to the next state?
- Should a geo-tag selection in the map-only state change the state to map+list automatically, so that the filtered list becomes visible?
- What are the query parameter names for the time range (for example `from`/`to` or `year`/`month`)? They must match the timeline's current granularity.