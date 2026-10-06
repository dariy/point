# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

---


## 2026-10-06 - p-atlas-layer-p2-rwea.1
- Atlas map now starts below header and timeline. `atlasLayerLayout.ts` publishes `--atlas-layer-top` (header bottom + `#timeline-mount` height) and re-measures on DOM change and resize. `atlas.css`: map `top` uses it; `#timeline-mount` is sticky under the header (z 109) in every atlas state.
- Files: `frontend/src/plugins/tags-atlas/atlasLayerLayout.ts`, `frontend/css/public/atlas.css`, `frontend/e2e/atlas-layer-header.test.ts`, rebuilt CSS bundles.
- **Learnings:**
  - The timeline fills `#timeline-mount` after layout mounts, so a MutationObserver on `#app` is needed to find it.
  - Dev/throwaway seed data gives no timeline pills (`/api/timeline` 404), so the e2e test injects a `.timeline-container` into the real mount.
  - `insertAdjacentHTML` fails in page context (TrustedHTML); use createElement.
  - Dev DB login fails (401); use a throwaway instance (`/tmp/pv2`, port 8146) per memory notes.
---

## 2026-10-06 - p-atlas-layer-p2-rwea.3
- Handle now holds buttons. mapList: "Maximize map" and "Maximize list". list and map: one "Restore map and list". `atlasLayerHandle.ts` re-renders them on `data-atlas-layer` change. Gesture `onDown` ignores presses on `.atlas-layer-handle__btn`.
- Files: `atlasLayerHandle.ts`, `atlasLayerGesture.ts`, `css/public/atlas.css` (+ bundles), `e2e/atlas-layer-gesture.test.ts`.
- **Learnings:**
  - Handle is 20px, so the 44px buttons are absolutely positioned and overflow it with no fill.
  - Use `globalThis.Element` in TS; oxlint flags bare `Element` (no-undef).
  - Full e2e flaked on atlas-layer.test.ts "handle not visible" in two runs; passes alone and on rerun.
---

## 2026-10-06 - p-atlas-layer-p2-rwea.9
- Bug cause: in map+list the grid is a fixed bottom strip. The home fit (`computePerPage`) measured it as one row and wrote `per_page=1` to the URL, which also stuck in list-only. Fix: each state fits its own per_page on the same collection. `computePerPage` has a strip branch (`stripPerPage`: two screens of square cards from the strip height). `watchAtlasLayer` re-fits on a state change (HomePage and TagPage), through the existing `refitPage` path. `map` skips the fit. `GridPager._loadMoreAtStripEnd` loads the next page at the strip end.
- Files: `utils/gridFit.ts`, `pages/public/HomePage.ts`, `pages/public/TagPage.ts`, `core/gridPager.ts`, `e2e/atlas-layer-list.test.ts`.
- Checked: 390×844 list 1 → map+list 6; 820×1180 list 2 → map+list 8; first post same after list → map+list → list. js-lint, js-typecheck, js-test pass. Full e2e: 50/53 pass.
- **Learnings:**
  - 3 tests in `atlas-layer-map.test.ts` (country shape, marker, country select) fail with and without this change. They were failing before.
  - First-post identity is page-aligned (`refitPage`), exact on page 1. No offset API exists.
  - `scripts/run-e2e.sh` hardcodes the test glob; copy it to run one file.
---

## 2026-10-06 - p-vfhf
- `show` now resets the paginator to one page. `_goto` ignores requests while `_pagination` is null (no page loaded).
- Files: frontend/src/plugins/tags-atlas/AtlasSheet.ts, frontend/test/AtlasSheet.test.ts
- **Learnings:**
  - `_pagination = null` alone does not change the mounted Pagination. Call `setProps` too.
---

## 2026-10-06 - p-xdaw
- Decision: slimmer grip (1.1rem -> 0.9rem) and bar (2rem -> 1.75rem) at max-width 480px. Row height goes from about 115px to about 108px; 3 squares need row height <= 114px at 358px row width.
- Files: `frontend/css/public/atlas.css` (+ bundles).
- Not checked: no 390x844 screenshot taken; the count comes from the arithmetic in `fitColumns`.
- **Learnings:**
  - At 390px the 2-card result missed 3 by about 1px of card height, so a small trim is enough.
---

## 2026-10-06 - p-atlas-layer-1qus
- Epic close-out. All nine children (US-001 to US-009) were already closed. No code changed in this step.
- **Learnings:**
  - 3 tests in `atlas-layer-map.test.ts` still fail (pre-existing). Follow up in a separate bead.
---

## 2026-10-06 - p-atlas-layer-p2-rwea.1 (verify pass)
- Work already existed. Re-ran `scripts/check.sh`: all pass except 3 known `atlas-layer-map.test.ts` failures (pre-existing). Bead closed.
---

## 2026-10-06 - p-atlas-layer-p2-rwea.2
- Map-only state now shows a minimized footer: copyright only, fixed under the handle, `padding-bottom: env(safe-area-inset-bottom)`. `atlasLayerLayout.ts` publishes `--atlas-layer-footer-h` (height of `#footer-mount`); map and handle `bottom` use it. With no footer plugin the mount is empty, so the value is 0px and the handle sits at the page bottom. mapList still hides the footer; list is unchanged.
- Files: `css/public/footer.css`, `css/public/atlas.css`, `src/plugins/tags-atlas/atlasLayerLayout.ts`, `e2e/atlas-layer.test.ts`.
- Checked: atlas-layer, -header, -gesture e2e pass (20/20) on a throwaway instance. check.sh: only the known atlas-layer-map.test.ts failure (country shape) remains. No manual 820×1180 screenshot; the e2e runs at 390×844.
- **Learnings:**
  - The footer is in `#footer-mount`; hide its `.footer-center`/`.footer-right` to keep the copyright only.
  - Dev DB login still gives 401 on :8001; `E2E_PORT=<free> scripts/run-e2e.sh` (with a narrowed glob) works.
---

## 2026-10-06 - p-atlas-layer-p2-rwea.4
- Free drag on the handle. A vertical drag sets `body[data-atlas-dragging]` and `--atlas-layer-list-h` (height under the map); map, handle and card row follow it live. On release `snapState` (pure) picks the nearest of three handle positions; a flick (>= 0.5 px/ms over the last 100ms) moves one state. The handle slides there (`data-atlas-snapping`, 0.2s, none under reduced motion), then the state changes.
- Files: `atlasLayerGesture.ts`, `css/public/atlas.css`, `css/public/footer.css` (minimized footer during drag), `core/gridPager.ts`, `utils/gridFit.ts`, `test/atlasLayerGesture.test.ts`, `e2e/atlas-layer-gesture.test.ts`.
- Checked: check.sh --short passes; gesture e2e 10/10 at 390x844. Not checked by hand: 820x1180 browser pass.
- **Learnings:**
  - A drag resizes the chrome, which fired the chrome refit and `GridPager.arm()`, which tore down the gesture mid-drag. Fix: `watchChromeFit` waits while dragging; `arm()` keeps the gesture when the handle is the same.
  - Synthetic mouse moves have near-equal timestamps; test drags need distance or slow steps to avoid or force a flick.
  - A drag started before the first grid fit can still be cut off by the re-render.
---

## 2026-10-06 - p-atlas-layer-p2-rwea.5
- `atlasLayerMap.ts` already mounts `AtlasPlaces` (country shapes, geo-tag markers, tag-post graph) and calls `invalidateSize` on state change and through a ResizeObserver (covers drag). No app code change needed.
- The 3 failing tests failed for a test-setup reason: `tags_visibility` defaults to `hidden`, so the anonymous `/api/pages/graph` returned 404. The test now sets `tags_visibility=all` with `PUT /api/settings` in `before`.
- Files: `frontend/e2e/atlas-layer-map.test.ts`.
- Checked: map test 6/6; full e2e 54/54 on rerun. Not checked by hand: playwright-cli at 820×1180 (the e2e runs at 390×844).
- **Learnings:**
  - A public graph 404 means `tags_visibility` is not `all`; check it first.
  - `scripts/check.sh` e2e flakes on "handle not visible" in one run; it passes on rerun.
---

## 2026-10-06 - p-atlas-layer-p2-rwea.6
- A geo-tag picked on the map sets `?place=<slug>` (`ViewContext.place`, home path only; page resets to 1; `atlas` and `view` params stay). `HomePage._fetchFeed` loads the list from the tag-page endpoint when `place` is set (the home endpoint has no tag filter). A removable chip (`#atlas-filter-mount`, `.atlas-filter-chip`) shows the filter; it floats over the map in mapList and map. A click on the chip or on empty map clears the filter and the map pick (`atlas-place-clear` event).
- Files: `utils/viewContext.ts`, `pages/public/HomePage.ts`, `plugins/tags-atlas/{AtlasPlaces,atlasLayerMap}.ts`, `core/gridPager.ts`, `css/public/atlas.css`, `e2e/atlas-layer-map.test.ts` (3 new tests).
- Checked: map e2e 9/9; atlas-layer e2e 37/37. Not checked by hand: playwright-cli at 820x1180. TagPage and SearchPage do not apply `place` (home only).
- **Learnings:**
  - `GridPager.disarm()` destroyed the layout (the map container) and the map on every list refresh, so a selection died on any refit. `disarm()` now keeps both; `destroy()` releases them.
  - In `scripts/check.sh` the e2e step flakes on "handle not visible" or tile tests in a different place each run; the baseline without this change flakes too. Atlas e2e passes alone.
---
