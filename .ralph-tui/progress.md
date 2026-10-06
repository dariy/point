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
