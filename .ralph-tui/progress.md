# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

- **Header slots**: the header (`PublicHeader`) fills the `timeline` slot itself from the `timeline`/`onTimeline` props; pages never render `#timeline-mount`.

---


## 2026-10-06 - p-atlas-header-line-f97s.1
- Timeline moved into the header row: `PublicHeader` renders `.site-timeline#timeline-mount` between the context and nav zones and fills the `timeline` slot (props `timeline`, `onTimeline`). HomePage, TagPage, tags-graph, tags-map pass the context there and no longer render their own mount.
- Removed the old timeline row: atlas `--atlas-layer-top` now equals the header bottom; `#timeline-mount` sticky rule removed from atlas.css; gridFit no longer measures `#timeline-mount` separately.
- Files: PublicHeader.ts, HomePage.ts, TagPage.ts, tags-graph/index.ts, tags-map/index.ts, atlasLayerLayout.ts, gridFit.ts, header.css, timeline.css, atlas.css, e2e/atlas-layer-header.test.ts.
- Checked at 1440px: header is one 72px row on `/` and `/tags`. At 390px the header wraps (timeline on its own row) until US-009.
- **Learnings:**
  - Baseline e2e already fails: Atlas gestures "free drag" (flaky), Trusted Types tags-map marker click, and some Atlas layer/list tests while WIP is stashed. Not caused by this task.
  - Header re-fill (graph breadcrumb update) remounts the timeline; the module-level view restore hides the blink.
  - The old histogram timeline is clipped to header height; US-002 replaces the content.
---

## 2026-10-06 - p-atlas-header-line-f97s.2
- Rewrote the timeline plugin as a pill strip. Collapsed: one "All years" pill. Expanded: one `aria-pressed` button per year (decade pills dropped), ascending, no arrows, inactive pills `opacity: .5` until hover/focus. The strip scrolls sideways (touch, wheel) and centres the active pill.
- Same host interface kept: `onRangeChange({from,to,isFullExtent})`, `setScope`, `setCount`, `mount()` export. Added `expand()`, `collapse()`, `focusYear()` for US-003/US-004.
- Interim: click on "All years" expands to the last focused year (else newest); no collapse control until US-003.
- Files: plugins/timeline/index.ts, css/public/timeline.css, test/Timeline.test.ts (rewritten, 5 tests).
- Checked in a browser at 1440px and 390px on :8001.
- **Learnings:**
  - A slot plugin must keep its `export function mount(el, ctx)`; without it the slot stays empty and nothing errors.
  - `scripts/check.sh` e2e failures this run were only Atlas layer gesture/list tests, and the set changed between runs (flaky, as in US-001).
---
