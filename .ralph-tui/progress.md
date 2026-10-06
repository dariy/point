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
