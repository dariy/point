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
