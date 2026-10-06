# PRD: Atlas Map Layer on Post List Pages

## Overview
When the Atlas plugin (`tags-atlas`) is on, every post list page (home, tag, search, profile) gets a map layer that is collapsed by default. The page has three states:

1. **List**: the default. You see the header, the post list, and the footer. A grab handle at the top of the post list shows that a map is available.
2. **Map + list**: the map comes down from behind the header and sits between the header and the post list. The post list moves over the footer and its height shrinks to about 1/5 of the window height. The footer is hidden.
3. **Map only**: the map fills the space below the header. The post list collapses to a handle at the very bottom of the window. The footer is hidden.

A swipe down that starts on the post list control moves one state toward "map only". A swipe up moves one state back. A tap on the handle also cycles through the states. The map shows only the posts in the current list (same filter). Gestures inside the map area go to the map first (pan, zoom). The sheet takes a gesture only when it starts on the handle or the post list control. This feature replaces the `/map` page: `/map` opens a post list page in the "map only" state. The `AtlasSheet` component (commits d92497c6, 7d74b866) is reused for the list part where it fits.

## Goals
- On every post list page, show the post list and its locations together with no page navigation.
- Keep the default "list" state identical to the current page, except for one grab handle.
- Give one consistent three-state model on touch, mouse, and keyboard.
- Never let the map lose a gesture to the sheet when the gesture starts inside the map.
- Remove the separate `/map` page as a different UI, but keep the `/map` URL working.

## Quality Gates

These commands must pass for every user story:
- `scripts/check.sh` - lint, type check, unit tests, and coverage
- `scripts/run-e2e.sh` with the atlas Playwright specs (`e2e/atlas*.spec.ts`)

For UI stories, also do this:
- Do a check in a real browser with the playwright-cli skill against `scripts/run.sh` on `http://localhost:8001`. Use a mobile viewport (390×844, touch) and a desktop viewport (1440×900). Take a screenshot of each state that the story changes.

## User Stories

### US-001: Atlas layer state model and e2e harness
As a developer, I want one state machine for the three layer states and a base e2e spec, so that all later stories use the same state source and tests.

**Acceptance Criteria:**
- [ ] A new module `frontend/src/plugins/tags-atlas/atlasLayerState.ts` exports the type `AtlasLayerState = 'list' | 'mapList' | 'map'` and the pure functions `next(state)`, `prev(state)`, and `cycle(state)`.
- [ ] `next('list') === 'mapList'`, `next('mapList') === 'map'`, `next('map') === 'map'`; `prev` is the reverse and stops at `'list'`; `cycle('map') === 'list'`.
- [ ] The current state is put on `document.body` as the attribute `data-atlas-layer="<state>"`. It is the only source that CSS reads.
- [ ] Unit tests in `frontend/test/atlasLayerState.test.ts` cover all transitions.
- [ ] A new `e2e/atlas-layer.spec.ts` exists. It enables the tags-atlas plugin (see the memory "Dev DB admin login" for the method) and checks that `data-atlas-layer="list"` is on the home page.

### US-002: Collapsed handle on all post list pages
As a visitor, I want to see a grab handle at the top of the post list when Atlas is on, so that I know a map is available.

**Acceptance Criteria:**
- [ ] When the tags-atlas plugin is enabled, home, tag, search, and profile pages show a handle element (`.atlas-layer-handle`, `role="button"`, `aria-label`, `aria-expanded`) at the top of the post list.
- [ ] When the plugin is disabled, there is no handle and no change in the DOM or layout on these pages.
- [ ] In the "list" state the header, post list, and footer look as they do now. The only difference is the handle (height ≤ 24px).
- [ ] Mounting goes through the existing `GridPager` / `frontend/src/core/gridPager.ts` sheet hooks (from commit 35e00469). No page-specific code is necessary.
- [ ] The e2e spec checks that the handle is on all four page types and is not there when the plugin is off.

### US-003: Map + list state layout
As a visitor, I want the map to come down from behind the header, with the post list as a short strip below it, so that I can see the map and the posts together.

**Acceptance Criteria:**
- [ ] In `mapList`, the map container is between the bottom of the header and the top of the post list. It enters with a transform animation from behind the header (the header has a higher z-index than the map).
- [ ] The post list area has a height of `max(20vh, one card row + handle)` and is fixed at the bottom of the viewport, over the footer position.
- [ ] The footer (`PublicFooter`) is hidden (`display:none` or `visibility:hidden` and `inert`) in `mapList` and `map`. It is visible only in `list`.
- [ ] The post list in this state is one horizontally scrolling row of `PostCard`s, and it reuses `AtlasSheet` (`fitColumns`, `CARD_ASPECT`, `SHEET_GAP_PX`).
- [ ] Animations obey `prefers-reduced-motion: reduce` (no slide; immediate change).
- [ ] CSS goes in the source files `frontend/css/public/atlas.css` and `footer.css`, then `scripts/build-css.sh` is run. Do not edit the generated bundles.
- [ ] The e2e spec sets `mapList` and checks: the map is visible, the footer is hidden, and the list height is within 15–25% of the viewport height.

### US-004: Map-only state layout
As a visitor, I want a map-only view where the post list is only a handle at the very bottom, so that I can explore the map with all the space.

**Acceptance Criteria:**
- [ ] In `map`, the map fills the space from the bottom of the header to the bottom of the viewport.
- [ ] The post list collapses to a handle (≤ 32px) at the very bottom of the viewport. No cards are visible.
- [ ] The footer is hidden.
- [ ] The e2e spec checks these three conditions.

### US-005: Map shows only the posts of the current list
As a visitor, I want the map to show only the posts in the list I am on, so that the map and the list agree.

**Acceptance Criteria:**
- [ ] The map gets the same filter as the post list (home: all visible posts; tag: that tag; search: that query; profile: that author).
- [ ] When the list loads more pages or the filter changes, the map markers update. There is no full map reload.
- [ ] The map loads its data and tiles only on the first change out of `list` (lazy). A page that stays in `list` makes no map requests.
- [ ] The e2e spec checks on a tag page that the marker count equals the number of geotagged posts with that tag. It also checks that no map tile request occurs in `list`.

### US-006: Swipe and tap gestures with map-first priority
As a touch user, I want to swipe on the post list control to change states, and I want map gestures to always go to the map, so that the two do not fight.

**Acceptance Criteria:**
- [ ] A vertical swipe that starts on the handle or the post list control (not inside a horizontally scrolling card row's scroll gesture) does this: down → `next`, up → `prev`. The threshold is ≥ 40px or a fling velocity ≥ 0.5 px/ms. A vertical drag that is less than this snaps back.
- [ ] While the user drags, the sheet follows the finger. When the user releases, it snaps to the nearest state.
- [ ] A pointer gesture that starts inside the map area always goes to the map (pan, pinch, double-tap zoom). It never changes the layer state, even when the map is at a pan limit.
- [ ] A horizontal swipe on the card row scrolls the cards and does not change the state (axis lock after the first 8px of movement).
- [ ] A tap on the handle calls `cycle`.
- [ ] The page does not scroll during a sheet drag (`touch-action` and `overscroll-behavior` are set on the control).
- [ ] Unit tests cover the gesture classifier (start target, axis lock, threshold, velocity). The e2e spec does touch swipes in the mobile viewport and checks each transition. It also checks that a swipe down inside the map pans the map and does not change the state.

### US-007: Desktop mouse, wheel, and keyboard
As a desktop user, I want the same three states with mouse drag, wheel, and keyboard, so that I can use the feature without touch.

**Acceptance Criteria:**
- [ ] A mouse drag on the handle or the list control acts as a swipe (same thresholds as US-006).
- [ ] A wheel event over the handle changes the state (down → `next`, up → `prev`, one step for each gesture, with a debounce). A wheel event over the map always zooms the map. A wheel event over the card list scrolls the list.
- [ ] The handle is focusable. Enter and Space call `cycle`. ArrowDown calls `next`. ArrowUp calls `prev`. Escape goes to `list`.
- [ ] `aria-expanded` and an `aria-live` label tell the current state.
- [ ] The e2e spec in the desktop viewport checks the drag, wheel, and keyboard paths.

### US-008: URL state, `/map` redirect, and return from a post
As a visitor, I want the layer state in the URL, so that back, reload, and shared links open the same view, and old `/map` links still work.

**Acceptance Criteria:**
- [ ] The state is in the query string as `?atlas=map` or `?atlas=list-map`. When it is absent, the state is `list`. A state change uses `history.replaceState` (one history entry is not added for each swipe).
- [ ] `/map` (and its old query parameters) redirects to the home post list with `?atlas=map`. Old map viewport parameters are kept if they exist.
- [ ] When a user opens a post from `mapList` or `map` and then goes back, the same state and map viewport come back (reuse or replace `frontend/src/utils/atlasReturn.ts`).
- [ ] The old separate `/map` page UI and the side panel or `AtlasPage` code that has no use now are removed. Their tests are removed or moved to the new specs.
- [ ] `docs/plugins/tags-atlas.md` describes the three states, the gestures, and the `/map` redirect.
- [ ] The e2e spec checks the `/map` redirect, a reload in each state, and the return from a post.

### US-009: Header interaction
As a visitor, I want the header to stay stable over the map, so that the map always appears to come from behind it.

**Acceptance Criteria:**
- [ ] In `mapList` and `map`, the header does not fold or compact on scroll (`headerFold.ts` / `headerCompact.ts` do not run while the state is not `list`). When the state goes back to `list`, the header behavior is the same as before.
- [ ] A state change does not close overlays that the user opened from the header (see the HeaderFold reset rule).
- [ ] The e2e spec checks that the header position does not change during a swipe in `mapList`.

## Functional Requirements
- FR-1: The system must show the atlas layer only when the tags-atlas plugin is enabled.
- FR-2: The system must support exactly three states: `list`, `mapList`, and `map`. The default is `list`.
- FR-3: The footer must be visible only in the `list` state.
- FR-4: In `mapList`, the post list must be over the footer position, with a height of about 20% of the viewport.
- FR-5: In `map`, the post list must collapse to a handle at the very bottom of the viewport.
- FR-6: The map must come from behind the header and must stay under it in z-order.
- FR-7: A gesture that starts inside the map must go only to the map.
- FR-8: A state change must occur only from a gesture that starts on the handle or the post list control, from a tap on the handle, or from the keyboard.
- FR-9: The map must show only the posts that match the current list filter.
- FR-10: The map must not load until the state changes out of `list` for the first time.
- FR-11: The URL must contain the state. `/map` must redirect to the home list in the `map` state.

## Non-Goals
- The map viewport does not filter the post list (no "search this area").
- No side-by-side desktop layout.
- No change to the post page, the admin UI, or the studio.
- No new map provider or tile source.
- No clustering changes other than what the current atlas map does.
- No changes to the `carousel-studio` branch.

## Technical Considerations
- Main files: `frontend/src/plugins/tags-atlas/{index.ts,AtlasSheet.ts}`, `frontend/src/core/gridPager.ts`, `frontend/src/components/public/PostCard.ts`, `frontend/src/plugins/public-footer/PublicFooter.ts`, `frontend/src/utils/{atlasReturn,headerFold,headerCompact}.ts`, `frontend/css/public/{atlas,footer,header}.css`.
- The branch `atlas-sheet` already has the sheet hooks in `GridPager`/`PostCard` and the `AtlasSheet` component. Build on them; do not duplicate them.
- No atlas e2e spec exists now. US-001 creates `e2e/atlas-layer.spec.ts`.
- Use Pointer Events with `setPointerCapture` for drag. Use `touch-action: none` only on the handle and `pan-x` on the card row.
- Use `transform` for animations (no layout thrash). Use `100dvh` for mobile viewport height.
- The frontend is TypeScript. Edit CSS sources only and run `scripts/build-css.sh`.

## Success Metrics
- All four post list page types show the handle and reach all three states on mobile and desktop.
- Zero map requests on pages that stay in `list`.
- No e2e flake in 3 consecutive `scripts/run-e2e.sh` runs.
- A swipe inside the map never changes the state (e2e).

## Open Questions
- In `mapList`, does a tap on a map marker scroll the card row to that post, or does it open the post?
- On a page with no geotagged posts, is the handle hidden, or does the map show an empty state?
- Must the state persist across page navigation (for example, from home to a tag page while in `mapList`), or reset to `list`?