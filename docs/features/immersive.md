# Immersive Mode & Media Viewer

Full-screen, distraction-free post viewing. The viewer is a plugin family around the
`post-viewer` enhancer slot:

- **`immersive`** (default) — the standard full-screen carousel
  (`frontend/src/plugins/immersive/MediaViewer.js`): keyboard navigation
  (arrows/Home/End/PageUp/PageDown), swipe with gesture handling (`gestures.js`),
  pinch-to-zoom and drag-to-pan on touch, slide indicators, chrome auto-hide
  (`body.ui-hidden` fades header/footer/close/dots), cross-post navigation (advancing
  past the last slide routes to the next post), and a per-slide URL hash.
- **`immersive-sheet`** — an alternative sheet-style presentation; exclusive with
  `immersive` (`Area: "immersive"` in the registry — exactly one is active).
- **`immersive-share`** — a small slot plugin injected into the viewer wrapper: native
  `navigator.share` where available, copy-link + toast fallback; shares the current
  slide URL.
- **`slideshow`** — see below.
- **`distraction-free`** — a post-list-tools slot toggle for chrome-free browsing of
  the list views.

Post-level control: posts have an immersive mode setting (auto-detect by content, with
per-post override in the editor's Details). Esc always exits.

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
