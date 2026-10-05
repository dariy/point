# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

---


## 2026-10-05 - p-atlas-sheet-ft0b.1
- Added `edgeArrows` and `onVerticalSwipe` to GridPager, `onOpen` to PostCard and PostGrid.
- New `utils/atlasReturn.ts` owns both sessionStorage keys. PostContent close now goes to `takeAtlasReturn(slug)` (`/map` fallback), not `/tags`.
- Atlas writes `returnUrl` as `pathname + search`. TagPage and PostPage clear the open marker.
- Files: core/gridPager.ts, components/public/{PostCard,PostGrid,PostContent}.ts, pages/public/{PostPage,TagPage}.ts, plugins/tags-atlas/index.ts, utils/atlasReturn.ts, tests (gridPager, postCardOpen, atlasReturn, AtlasPage).
- **Learnings:**
  - `memoryStorage` is in `test/helpers/mock.ts`. Atlas tests that write `returnUrl` must stub `globalThis.location`.
  - `edgeArrows: false` sets `_navArrows = []` so teardown still works.
  - Not done: browser check on :8001; branch push and draft PR.
---
