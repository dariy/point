# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

---


## 2026-10-06 - p-atlas-layer-1qus.1
- Added `atlasLayerState.ts`: `AtlasLayerState`, pure `next`/`prev`/`cycle`, plus body-attribute get/set/clear helpers.
- `app.ts` sets `data-atlas-layer="list"` on `<body>` at boot when `tags-atlas` is enabled.
- Unit tests in `frontend/test/atlasLayerState.test.ts`. E2E in `frontend/e2e/atlas-layer.test.ts`.
- Files: frontend/src/plugins/tags-atlas/atlasLayerState.ts, frontend/src/app.ts, frontend/test/atlasLayerState.test.ts, frontend/e2e/atlas-layer.test.ts
- **Learnings:**
  - E2E files live in `frontend/e2e/*.test.ts` (node --test glob), not `e2e/*.spec.ts` as the PRD says. Later stories add `atlas-*.test.ts` there.
  - `tags-atlas` is `DefaultEnabled: true`, so a fresh e2e DB has it on; no enable step is needed.
  - The e2e server is a fresh DB per run; each file calls `/api/setup` and accepts 409.
---

## 2026-10-06 - p-atlas-layer-1qus.2
- Added `atlasLayerHandle.ts` (`mountAtlasLayerHandle`): a `.atlas-layer-handle` div (role=button, aria-label, aria-expanded, tabindex 0, 20px) inserted before `#grid-mount`.
- `GridPager.arm()` mounts it when `pluginHost.isEnabled('tags-atlas')`; `disarm()`/`destroy()` remove it. No page-specific code.
- CSS in `frontend/css/public/atlas.css`. E2E: handle on home/tag/search, absent when plugin off.
- Files: frontend/src/plugins/tags-atlas/atlasLayerHandle.ts, frontend/src/core/gridPager.ts, frontend/css/public/atlas.css, frontend/e2e/atlas-layer.test.ts
- **Learnings:**
  - Trusted Types is enforced: build DOM with createElement, never `innerHTML` (trustedTypes e2e catches it).
  - GridPager unit tests run without a DOM `document.querySelectorAll`; keep a ref to the node and remove it, do not query.
  - Disabling a plugin: a reused browser context still showed the old manifest; use a fresh context in the "off" e2e.
  - No profile page exists in this tree (routes: /, /tags/:slug, /search); the AC "profile" has nothing to cover.
  - Handle has no click/gesture yet; US-006/007 add them. Browser screenshot check was not done in this session.
---

## 2026-10-06 - p-atlas-layer-1qus.3
- `mapList` layout, all in CSS keyed on `body[data-atlas-layer]`: `.atlas-layer-map` (fixed, z 100, under `#header-mount` z 110, slides from `translateY(-100%)`), `#grid-mount` becomes a fixed one-row strip at the bottom (height `max(20dvh, handle + 120px)`), handle sits on top of the strip, `#footer-mount` is `display:none` in `mapList`/`map`. `map` also hides the grid (US-004 will refine).
- New `atlasLayerLayout.ts` (`mountAtlasLayerLayout`): makes the empty map container on `body`, publishes `--atlas-layer-header-h`, `--atlas-layer-gap` (SHEET_GAP_PX), `--atlas-layer-aspect` (CARD_ASPECT). `GridPager.arm()` mounts it; `disarm()/destroy()` clean up and reset the state to `list`.
- Files: frontend/src/plugins/tags-atlas/atlasLayerLayout.ts, frontend/src/core/gridPager.ts, frontend/css/public/{atlas,footer}.css, frontend/e2e/atlas-layer.test.ts
- **Learnings:**
  - The map container is empty; the real map loads in US-005. `fitColumns` is not used: the row is CSS flex, card size = row height, so no per-page column count exists yet.
  - The page size of the grid is not changed in `mapList`; the row scrolls with the cards of the current page.
  - The e2e must wait for the slide to end (`transform === 'none'`) before it measures the map.
  - `check.sh` e2e had one flaky "code editor survives an undo" failure (passes on rerun and on baseline reruns).
  - Handle `aria-expanded` does not follow the state yet; US-006/007 wire it. No browser screenshot in this session; the e2e measures the geometry at 390×844.
---

## 2026-10-06 - p-atlas-layer-1qus.4
- `map` state: the map container now runs from the header bottom to the viewport bottom (`bottom: 0`); the 20px handle floats over it at the very bottom (z 105). Grid and pagination stay hidden, so no card shows; footer hidden since US-003.
- E2E: new case in `frontend/e2e/atlas-layer.test.ts` (map top = header bottom, map bottom = 844, handle ≤ 32px at the bottom, no card visible, footer hidden).
- Files: frontend/css/public/atlas.css, frontend/e2e/atlas-layer.test.ts
- **Learnings:**
  - US-003 already did most of the `map` layout; this story only changed the map `bottom`.
  - `check.sh` e2e failed twice in `trustedTypes.test.ts` (flaky) and passed on the third run. No browser screenshot in this session.
---

## 2026-10-06 - p-atlas-layer-1qus.5
- New `atlasLayerMap.ts` (`mountAtlasLayerMap`): lazy map for the layer. A MutationObserver on `body[data-atlas-layer]` waits for the first state other than `list`, then loads Leaflet and every page of the list through the pager's own `fetchPosts` (same filter as the cards), and draws one marker per geotagged post (first place tag). `refresh()` diffs markers by post id; the map is never rebuilt.
- `GridPager.arm()` mounts it on the `.atlas-layer-map` container and calls `refresh(pagination)`; `disarm()/destroy()` remove it. New option `filterKey` (Home/Tag/Search pass it) decides if a re-arm means a new list; the key also includes `pagination.total`.
- Files: frontend/src/plugins/tags-atlas/atlasLayerMap.ts, frontend/src/core/gridPager.ts, frontend/src/pages/public/{Home,Tag,Search}Page.ts, frontend/test/atlasLayerMap.test.ts, frontend/e2e/atlas-layer-map.test.ts
- **Learnings:**
  - Post list responses carry `tags[].latitude/longitude` on place tags, so no extra geo request is needed.
  - `page.route` globs match the whole URL: use a regex (`/arcgisonline\.com/`) for a host with a subdomain, or the route never fires and the assert passes without proof.
  - The map reads at most 30 pages (`MAX_MAP_PAGES`) at the device-fit `per_page`; a big list may need a dedicated endpoint later.
  - No profile page in this tree. No browser screenshot in this session; the e2e checks marker count and tile requests at 390×844.
  - `trustedTypes.test.ts` "tags map" failed once (marker click intercepted), passed on rerun: known flake.
---

## 2026-10-06 - p-atlas-layer-1qus.6
- New `atlasLayerGesture.ts`: pure classifier (`lockAxis` 8px, `classifyRelease` 40px or 0.5 px/ms, `stateAfter`, `startsOnControl`) and `mountAtlasLayerGesture(handle, gridMount)`. Pointer events on `document`; a start counts only on the handle, or on the card row in `mapList`. The map has no listener, so map gestures never reach the sheet. Handle and strip follow the finger by `transform`, then the state changes (or snaps back). Tap on the handle = `cycle`. It also keeps `aria-expanded` in step with the state.
- `GridPager.arm()` mounts it after the handle; `disarm()/destroy()` tear it down.
- Files: frontend/src/plugins/tags-atlas/atlasLayerGesture.ts, frontend/src/core/gridPager.ts, frontend/test/atlasLayerGesture.test.ts, frontend/e2e/atlas-layer-gesture.test.ts
- **Learnings:**
  - Touch swipes in e2e: `ctx.newCDPSession` + `Input.dispatchTouchEvent` (Playwright's touchscreen only taps). Context needs `hasTouch`.
  - Lint has no `Node` global: use `globalThis.Node`. Unit tests fake it (no param properties: strip-only TS).
  - The handle already had `touch-action: none`; the card row has `pan-x`. No `overscroll-behavior` added on the handle (not scrollable); the row has `contain`.
  - `trustedTypes.test.ts` map tests flaked again (marker click intercepted), as before. No browser screenshot in this session.
---

## 2026-10-06 - p-atlas-layer-1qus.7
- Desktop input on the handle, all in `atlasLayerGesture.ts`: wheel (one step per gesture, 250ms quiet-time debounce, `passive:false` + preventDefault so the page does not scroll), keys (`stateAfterKey`: Enter/Space cycle, ArrowDown next, ArrowUp prev, Escape list), and a visually hidden `aria-live` span (`stateLabel`) inside the handle. Mouse drag already worked through the pointer events from US-006.
- Wheel listener sits on the handle only: the map and the card row have none, so they zoom and scroll as before.
- Files: frontend/src/plugins/tags-atlas/{atlasLayerGesture,atlasLayerHandle}.ts, frontend/css/public/atlas.css, frontend/test/atlasLayerGesture.test.ts, frontend/e2e/atlas-layer-gesture.test.ts
- **Learnings:**
  - A mouse leaves the 20px handle on its first move, before the 8px axis lock sets pointer capture, so the move target changed and the browser sent `pointercancel`. Capture now starts on pointerdown when the target is in the handle.
  - `GridPager.arm()` runs more than once per page; the old handle was replaced each time, which dropped keyboard focus. `mountAtlasLayerHandle` now reuses its handle.
  - E2E that measures the handle must wait until its box is stable (`settledBox`); the layout can still slide.
  - `check.sh` e2e failed in `trustedTypes.test.ts` on 3 of 4 runs (different cases each time); the atlas specs pass. No browser screenshot in this session.
---
