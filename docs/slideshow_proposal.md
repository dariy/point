# Plan: `slideshow` plugin

## Context

The immersive media viewer (`frontend/src/plugins/immersive/MediaViewer.js`) shows a
post's images/videos as a carousel. There's no hands-free way to watch a collection.
We want a **slideshow**: a button in the top-right (next to the close cross) that auto-
advances slides on a timer, plays videos in full, lets the user tune the speed and
shuffle the order, and dims its own chrome after a few seconds.

The viewer's plugin system already has the exact pattern we need: `immersive-share` is a
tiny slot plugin that `MediaViewer.afterRender()` injects into `.media-viewer-wrapper`
(see `MediaViewer.js:133` and `frontend/src/plugins/immersive-share/index.js`). The
slideshow is the same shape — a sibling floating control. Plugin-local CSS is auto-wired
(`build-css.sh` → `css/p/<id>.css`, `registry.go:LoadCssMap`/`BuildManifest`), so no
backend plumbing beyond one registry line.

Per the user's choices: slideshow **advances across posts** at the end of a collection,
controls render as a **bottom-center bar**, and interval+shuffle **persist in localStorage**.

## Architecture

A new `TypeSlot` plugin `slideshow`, mounted by MediaViewer into the same wrapper as the
share button. It needs to drive carousel navigation, so MediaViewer exposes a tiny stable
controller to it (not its internals).

Cross-post advance is **free**: `goTo(index+1)` at the last slide already triggers
`_navigatePost('fwd')` (`MediaViewer.js:189`), which is a full route swap → MediaViewer and
the slideshow plugin remount. To keep the show running across that remount, the plugin
keeps a **module-scoped `running` flag** (survives within the SPA session, like
`_suppressNextFadeIn` does in MediaViewer); on mount it auto-resumes if the flag is set.

## Files

**New** `frontend/src/plugins/slideshow/index.js` — `mount(wrapper, ctx)`, mirrors
immersive-share: builds the top-right toggle button, returns `{ unmount }`. Delegates to a
small controller class.

**New** `frontend/src/plugins/slideshow/Slideshow.js` — controller:
- **Button**: top-right toggle, `header-action-btn slideshow-btn`, PLAY ↔ PAUSE icon.
  Appended to wrapper (absolutely positioned, DOM order irrelevant).
- **Bottom bar** (built on start, removed on stop): `[− <n>s +]` interval stepper +
  shuffle toggle button (two-state, SHUFFLE icon, `.active` when on). `stopPropagation` on
  the bar so taps don't reach MediaViewer's close/hide handler. Buttons are already ignored
  by MediaViewer's `e.target.closest('a, button, …')` guard (`MediaViewer.js:232`).
- **Advance loop**: `setTimeout`-based (re-armed each step, not `setInterval`, so per-slide
  duration can vary). Image/text/audio slide → advance after `interval`. Video slide →
  remove the `loop` attr, listen once for `ended`, advance then (ignore interval; "play in
  full"); restore `loop` on stop/leave. Advance = `ctx.goTo(nextIndex)`; at collection end
  `ctx.goTo(ctx.count)` to force the forward cross into the next post.
- **Shuffle**: maintain a shuffled permutation of `0..count-1` for the current post; walk it;
  when exhausted, cross to next post (reshuffle on the fresh mount). Off = sequential.
- **Auto-hide**: while running, a ~3s inactivity timer adds `body.ui-hidden` (reuses the
  existing class that fades header/footer/close/dots; our CSS adds the bar+button). Any
  `pointermove`/`keydown`/`touchstart` removes `ui-hidden`, reshows controls, and resets
  **both** the inactivity timer and the advance timer (so manual nav doesn't double-jump).
- **visibilitychange**: pause the advance timer when the tab is hidden, resume on show.
- **Persistence**: `localStorage` keys `slideshow.interval` / `slideshow.shuffle`. Clamp
  interval to 1–30s, default 5s.
- **Resume**: module-scoped `running` flag; `mount()` auto-starts when set (cross-post
  continuation). Cleared on explicit stop.
- **unmount**: clear all timers/listeners, restore any video `loop`, remove bar+button.
  Does **not** clear the module flag (so the remount on cross-post nav resumes).

**New** `frontend/src/plugins/slideshow/slideshow.css` — `.slideshow-btn` (top-right,
offset left of the close/share cluster — verify against `.lightbox-close` `right:
var(--spacing-xl)` and `.carousel-share-btn` offsets; keep visible on mobile since the cross
is desktop-only), `.slideshow-bar` (bottom-center, above `.carousel-indicators`), and
`.ui-hidden` fade-out rules for both. Auto-bundled to `css/p/slideshow.css`.

**Edit** `frontend/src/plugins/immersive/MediaViewer.js`:
- In `_initInteractivity`, after `goTo` is defined, store `this._goTo = goTo;`.
- In `afterRender`, alongside the share fill, add:
  ```js
  if (this.props.items?.length > 1) {
    pluginHost.fill('slideshow', this.$('.media-viewer-wrapper'), {
      count: items.length,
      index: () => this._index,
      goTo: (i) => this._goTo(i),
      activeVideo: () => this._slides?.[this._index]?.querySelector('video') || null,
    });
  }
  ```
  (This is the only viewer change — a 4-method controller, no internals leaked.)

**Edit** `frontend/src/utils/icons.js` — add `MINUS_SVG`, `PAUSE_SVG`, `SHUFFLE_SVG`
(reuse existing `PLAY_SVG`, `PLUS_SVG`).

**Edit** `api/internal/plugins/registry.go` — register near `immersive-share`:
```go
{ID: "slideshow", Type: TypeSlot, Slot: "slideshow", EntryName: "slideshow", DefaultEnabled: true},
```

## Corner cases

- **< 2 items**: viewer doesn't fill the slot (guard above) — no button. Single-video post
  still gets no slideshow; the video already autoplays+loops.
- **End of feed** (no next post): `_navigatePost('fwd')` returns false, `goTo` wraps to
  index 0 of the same post — graceful loop-at-end fallback.
- **Looped video**: must drop `loop` so `ended` fires; restore on stop/leave so normal
  carousel behavior is unchanged when the show isn't running.
- **Audio/text slides**: treated as timed (interval), same as images.
- **Manual nav while running** (swipe/arrow/dot): the viewer already owns arrow-key nav
  (`MediaViewer.js:317` — Left/Right/Home/End/PageUp/PageDown → `goTo`, fires even while
  `ui-hidden`), so the slideshow adds **no** key handler of its own. Its existing
  pointer/key listener just resets the advance timer from the new position (no double jump)
  and, in shuffle mode, resyncs the shuffle pointer to the current index so the next
  auto-advance continues from where the user jumped. Spacebar stays the viewer's UI toggle —
  the slideshow's play/pause is the top-right button, so no key conflict.
- **Close / Esc while running**: viewer unmounts → plugin `unmount` clears timers and
  restores video; module flag is cleared by the explicit close path (stop button) — closing
  the viewer entirely also stops (clear flag in unmount when the document is leaving immersive;
  simplest: clear flag on Esc/close via the same toggle-off path, and treat a non-cross-post
  unmount as stop). Verify no runaway timer after close.
- **Tab hidden**: paused via visibilitychange so the show doesn't burn through slides.
- **Reduced motion**: feature is user-initiated; no auto-start, so acceptable.

## br tasks (create at implementation start)

1. **slideshow: scaffold plugin + registry + CSS wiring** — create `index.js`, empty
   `Slideshow.js`, `slideshow.css`; register in `registry.go`; confirm `build-js.sh` +
   `build-css.sh` emit the chunk, `css/p/slideshow.css`, and the manifest `css` field.
2. **slideshow: top-right toggle button** — PLAY/PAUSE button injected into wrapper, start/
   stop wiring, CSS position next to close/share (desktop + mobile).
3. **slideshow: MediaViewer controller hook** — `this._goTo` + `pluginHost.fill('slideshow', …)`
   with the 4-method controller; `>1` items guard.
4. **slideshow: timed advance loop** — re-armed `setTimeout` over images/text/audio;
   interval applied; wraps via `goTo(count)` to cross posts.
5. **slideshow: video plays in full** — drop `loop`, advance on `ended`, restore loop on
   stop; fallback to interval if no duration.
6. **slideshow: bottom-center control bar** — `[− Ns +]` stepper + shuffle toggle, build on
   start / remove on stop, `stopPropagation`, icons (`MINUS_SVG`, `SHUFFLE_SVG`).
7. **slideshow: shuffle ordering** — per-post permutation walk, reshuffle per cycle/post.
8. **slideshow: auto-hide chrome** — inactivity timer toggles `ui-hidden`; pointer/key
   reshow + timer reset; CSS fade for bar+button.
9. **slideshow: cross-post resume** — module-scoped running flag; auto-start on remount;
   stop clears flag.
10. **slideshow: persistence + visibilitychange** — localStorage interval/shuffle (clamp
    1–30s, default 5s); pause/resume on tab visibility.
11. **slideshow: verify build + manual QA** — full build, smoke per Verification below.

## Verification

1. Build: `bash scripts/build-js.sh && bash scripts/build-css.sh` — confirm
   `frontend/js/p/slideshow-*.js`, `frontend/css/p/slideshow.css`, and `slideshow` with a
   `css` field in `frontend/js/plugin-manifest.json`.
2. Run locally: `scripts/run-local.sh` (localhost:8001). Open a post with ≥2 media in
   immersive mode.
3. Manual checks:
   - Slideshow button appears top-right next to the close cross; starting it shows the
     bottom bar and begins auto-advancing at 5s.
   - `−/+` changes the interval live and persists across reload; shuffle toggle randomizes
     order and persists.
   - A video slide plays to its end before advancing (not cut at the interval).
   - After ~3s idle the chrome (button, bar, dots, header/footer) fades; moving the
     mouse/tapping brings it back.
   - At the last item the show advances into the next post and keeps running.
   - Switching browser tabs pauses it; returning resumes.
   - Closing the viewer (Esc/cross) stops it with no runaway timer (check console).
   - Disabling the `slideshow` plugin removes the button entirely.
