# Immersive Mode & Media Viewer

Full-screen, distraction-free post viewing. The viewer is a plugin family around the
`post-viewer` enhancer slot:

- **`immersive`** (default) — the standard full-screen carousel
  (`frontend/src/components/shared/MediaViewer.js`, mounted by
  `frontend/src/plugins/immersive/`): keyboard navigation
  (arrows/Home/End/PageUp/PageDown), swipe with gesture handling (`gestures.js`),
  pinch-to-zoom and drag-to-pan on touch, slide indicators, chrome auto-hide
  (`body.ui-hidden` fades header/footer/close/dots), cross-post navigation (advancing
  past the last slide routes to the next post), and a per-slide URL hash.
- **`immersive-sheet`** — an alternative sheet-style presentation. It and `immersive`
  are the two candidates for the `post-viewer` slot, whose cardinality is `1`
  (`SlotCardinality` in the registry): exactly one is active, and enabling one is what
  switches the other off.
- **`immersive-share`** — a small slot plugin injected into the viewer wrapper: native
  `navigator.share` where available, copy-link + toast fallback; shares the current
  slide URL.
- **`slideshow`** — see below.
- **`distraction-free`** — a post-list-tools slot toggle for chrome-free browsing of
  the list views.

Post-level control: posts have an immersive mode setting (auto-detect by content, with
per-post override in the editor's Details). Esc always exits.

## Transitions

Stepping from one slide to the next is not one behavior but **two independent
layers**, chosen by what the two slides are to each other — not by how the step was
triggered. Every entry point (arrow key, dot, swipe commit, cross-post nav) funnels
through the same choice, so a keyboard step and a finger step look identical.

| Layer | Applies to | Chosen by | Configurable |
|---|---|---|---|
| **Deck (panoramic)** | Two slides of the *same* rendered `:::{.carousel-block}` | `MediaViewer._seamlessPair()` — both items carry `carousel: true` from `postMedia.js` | No. Curated by the carousel feature; exactly one strategy |
| **General** | Everything else — unrelated photos/videos in a post, and post-to-post nav | `MediaViewer._transitionStrategy()` | Yes — the `transition_strategy` public setting |

### The deck strategy: panoramic

`frontend/src/utils/deckTransition.js` — pure geometry plus four DOM primitives, no
viewer internals. The studio slices one photo into continuity-matched columns, so two
adjacent slides are two halves of one picture and the step should read as a **pan
across a single image**, not a swap of two pictures.

The naive full-screen carousel step translates the whole viewport-sized
`.carousel-slide` box by ±`window.innerWidth`. On a letterboxed slide that is wrong
twice over: the two images are separated by the width of *two* letterbox margins, so a
gap of backdrop opens between them mid-step, and the outgoing slice crossfades to
`opacity: 0` through it. Instead:

1. `computeDeckGeometry()` measures both slides' rendered `<img>` and returns
   `{ imgW, marginW, viewportW }` — or `null` if either image is missing or the two
   differ in width by more than 1px, in which case the caller falls back to the legacy
   full-viewport pan unchanged.
2. `applyDeckClip()` sets `clip-path: inset(0 <marginW>px)` on **both** slide boxes.
   That is the mechanism behind "the image slides *under* the margin field": each box
   is now a window exactly the width of its own image, and the arithmetic overshoot
   past it is invisible rather than painted.
3. `setImgTranslateX()` translates each slide's inner `<img>` by ±`imgW` — its *own
   rendered width*, not the viewport's. The incoming image therefore starts exactly
   one image-width away, abutting the outgoing one edge to edge with no gap, and both
   are held at full opacity for the whole 0.3s.

Geometry is computed once per step and cached on `this._deckGeo`, keyed
`"oldIndex:newIndex"` — `getBoundingClientRect()` forces layout, and the drag path
would otherwise call it on every `pointermove`. The cache is cleared on step
completion and on any teardown.

The same primitives serve all three call sites, which is what keeps a drag and a
keypress consistent: `_seamlessStep()` (discrete step), `_commitHorizontal()` (drag
released past threshold) and the live drag handler, which clamps the finger offset to
`±imgW` so a fast swipe cannot drag past the seam.

### The general strategy: an admin setting

`transition_strategy` is a public setting (Settings → Display; allowlisted in
`api/internal/api/settings.go`, offered in `settingsFields.js`, read through
`getSettings()`), defaulting to `fade`. It selects between the `switch` arms in
`_generalSwap()` (instant swap for dot/keyboard/post-nav) and `_generalCommitFade()`
(animated drag-to-rest), which are the two places a non-deck transition is drawn.

`fade` is the only strategy shipped today, so the select currently offers one option —
deliberately: the value of the seam is that a second strategy is a new `case` in two
switches plus an `<option>`, with no call-site changes anywhere. The deck strategy is
kept out of it on purpose. It is not a taste choice an admin should be able to break;
it exists because the slices are pieces of one photo, and any other treatment shows a
seam that is not in the source.

## Slideshow

`frontend/src/plugins/slideshow/` (index.js + Slideshow.js + slideshow.css) — a
hands-free auto-advancing show inside the viewer. Implemented behavior:

- **Toggle button** top-right next to close/share (PLAY ↔ PAUSE); only offered when a
  post has ≥2 media items.
- **Bottom-center control bar**: interval stepper `[− Ns +]` (clamped 1–30 s, default
  5 s), shuffle toggle, and a loop toggle. Settings persist in localStorage
  (`slideshow.interval`, `slideshow.shuffle`, `slideshow.loop`).
- **Advance loop**: re-armed `setTimeout` (not `setInterval`) so per-slide duration can
  vary. Video slides play **in full** — the `loop` attribute is removed, advance fires
  on `ended`, and `loop` is restored on stop/leave. Images/text/audio use the interval.
- **Cross-post continuation**: a module-scoped `running` flag survives the SPA remount
  when the show crosses into the next post; `mount()` auto-resumes. Explicit stop /
  viewer close clears it (no runaway timers).
- **Shuffle**: per-post permutation walk, resynced when the user manually navigates.
- **Chrome auto-hide** while running (~3 s idle → `ui-hidden`; any pointer/key
  activity reshows and resets both the inactivity and advance timers so manual nav
  never double-jumps). `visibilitychange` pauses the show in hidden tabs.

### Architecture notes

- The viewer exposes a tiny controller to the slideshow via
  `pluginHost.fill('slideshow', wrapper, { count, index(), goTo(i), activeVideo() })` —
  no viewer internals leak into the plugin.
- The slideshow adds **no keyboard handler of its own**; arrow-key navigation stays
  owned by the viewer. Spacebar remains the viewer's UI toggle.
- At end of feed (no next post), `goTo` wraps to index 0 — graceful loop-at-end.

## Key decisions

- **Viewer extensibility via slots** (`immersive-share` proved the pattern; slideshow
  followed) — floating controls are sibling plugins, not viewer patches.
- **MediaLightbox vs. immersive carousel**: the admin/public lightbox
  (`frontend/src/components/public/MediaLightbox.js`) still duplicates some
  gesture/keyboard logic; long-term convergence into one media-viewer component with
  two entry modes remains the intended direction (from the public-UX proposal).

## Out of scope

- Auto-starting a slideshow (user-initiated only — also the reduced-motion answer).
- Single-media slideshow (a lone video already autoplays/loops).
