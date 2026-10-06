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
