/**
 * Slideshow — auto-advancing controller for the immersive MediaViewer.
 *
 * Drives the carousel through the small controller the viewer passes in
 * (count / index() / goTo(i) / activeVideo()); it never touches viewer
 * internals. A top-right button toggles the show; a bottom bar tunes speed and
 * shuffle. Images/text/audio advance on a timer; video plays to its end. After
 * a few idle seconds the chrome fades (shared `body.ui-hidden`).
 *
 * Cross-post advance is a full route swap that remounts the viewer and this
 * plugin, so run-state lives at module scope (`running`) and the show resumes on
 * the fresh mount — mirroring MediaViewer's `_suppressNextFadeIn`. `crossing`
 * marks our *own* end-of-collection advance so unmount() can tell an auto-cross
 * (resume) from a real close (stop).
 */

import { PLAY_SVG, PAUSE_SVG, MINUS_SVG, PLUS_SVG, SHUFFLE_SVG } from '../../utils/icons.js';

const MIN_INTERVAL = 1;
const MAX_INTERVAL = 30;
const DEFAULT_INTERVAL = 5;
const IDLE_MS = 3000;

// Survives the MediaViewer remount on cross-post navigation (see file header).
let running = false;
let crossing = false;

const clampInterval = (n) =>
  Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number.isFinite(n) ? n : DEFAULT_INTERVAL));

const loadInterval = () => clampInterval(parseInt(localStorage.getItem('slideshow.interval'), 10));
const loadShuffle = () => localStorage.getItem('slideshow.shuffle') === 'true';

export class Slideshow {
  constructor(wrapper, ctx) {
    this.wrapper = wrapper;
    this.ctx = ctx;
    this.interval = loadInterval();
    this.shuffle = loadShuffle();
    this.order = this._shuffled();

    // Mouse movement only reshows the chrome; deliberate navigation (keyboard /
    // touch) also resets the advance timer so a manual jump doesn't double-step.
    this._onPointer = () => this._activity(false);
    this._onNav = () => this._activity(true);
    this._onVisibility = () => this._visibility();

    this._buildButton();

    // Cross-post continuation: a show that was running before the remount picks
    // straight back up on this fresh instance.
    if (running) this.start();
  }

  // ── Top-right toggle button ───────────────────────────────────────────────
  _buildButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header-action-btn slideshow-btn';
    this._btn = btn;
    this._syncButton();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.wrapper.appendChild(btn); // absolutely positioned; DOM order irrelevant
  }

  _syncButton() {
    if (!this._btn) return;
    this._btn.innerHTML = running ? PAUSE_SVG : PLAY_SVG;
    this._btn.classList.toggle('active', running);
    this._btn.setAttribute('aria-label', running ? 'Pause slideshow' : 'Start slideshow');
  }

  toggle() {
    running ? this.stop() : this.start();
  }

  // ── Start / stop ──────────────────────────────────────────────────────────
  start() {
    running = true;
    crossing = false;
    this._syncButton();
    this._buildBar();
    document.addEventListener('pointermove', this._onPointer, { passive: true });
    document.addEventListener('touchstart', this._onNav, { passive: true });
    document.addEventListener('keydown', this._onNav);
    document.addEventListener('visibilitychange', this._onVisibility);
    this._resetInactivity();
    this._arm();
  }

  stop() {
    running = false;
    crossing = false;
    this._syncButton();
    this._removeBar();
    this._teardownRuntime();
    this._showChrome();
  }

  // Drop timers + activity listeners, restore any video loop. Shared by stop()
  // (explicit) and unmount() (viewer teardown).
  _teardownRuntime() {
    this._disarm();
    clearTimeout(this._idleTimer);
    document.removeEventListener('pointermove', this._onPointer);
    document.removeEventListener('touchstart', this._onNav);
    document.removeEventListener('keydown', this._onNav);
    document.removeEventListener('visibilitychange', this._onVisibility);
  }

  unmount() {
    this._teardownRuntime();
    this._removeBar();
    this._btn?.remove();
    this._btn = null;
    this._showChrome();
    // An auto-cross keeps the show alive for the remount; anything else
    // (Esc / close cross / leaving the page) is a real stop.
    if (crossing) crossing = false;
    else running = false;
  }

  // ── Advance loop ──────────────────────────────────────────────────────────
  _advance() {
    if (!running) return;
    const next = this._nextIndex();
    if (next >= this.ctx.count) {
      // End of this post's run → force the forward cross into the next post.
      crossing = true;
      this.ctx.goTo(this.ctx.count);
      // A real cross unmounts us within ~300ms (this timer is cleared in
      // _disarm). If we're still here after that — end of feed, where goTo just
      // wrapped within the post — recover: reshuffle and keep the show going.
      this._timer = setTimeout(() => {
        crossing = false;
        this.order = this._shuffled();
        this._arm();
      }, 800);
      return;
    }
    this.ctx.goTo(next);
    this._arm();
  }

  // Next slide index, or ctx.count to signal "cross to the next post". In
  // shuffle mode the pointer is re-derived from the live index each step, so a
  // manual jump (arrow/swipe/dot) just continues the walk from where the user
  // landed — no replay, no skip.
  _nextIndex() {
    const cur = this.ctx.index();
    const count = this.ctx.count;
    if (this.shuffle) {
      let pos = this.order.indexOf(cur);
      if (pos === -1) {
        this.order = this._shuffled();
        pos = this.order.indexOf(cur);
      }
      pos += 1;
      return pos >= this.order.length ? count : this.order[pos];
    }
    return cur + 1 >= count ? count : cur + 1;
  }

  // Arm the advance for the active slide. Video → play in full (drop `loop`,
  // advance on `ended`); everything else → fixed interval. Re-arming while the
  // same video is already playing is a no-op so mouse-move activity doesn't
  // restart it.
  _arm() {
    const video = this.ctx.activeVideo();
    if (video && video === this._armedVideo) return;
    this._disarm();
    if (video) {
      this._armedVideo = video;
      video.loop = false;
      this._onEnded = () => this._advance();
      video.addEventListener('ended', this._onEnded, { once: true });
      video.addEventListener('error', this._onEnded, { once: true });
      // Fallback if the duration never resolves (stalled/broken stream).
      if (!Number.isFinite(video.duration) || video.duration === 0) {
        this._timer = setTimeout(() => this._advance(), this.interval * 1000);
      }
      return;
    }
    this._timer = setTimeout(() => this._advance(), this.interval * 1000);
  }

  _disarm() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._armedVideo) {
      this._armedVideo.removeEventListener('ended', this._onEnded);
      this._armedVideo.removeEventListener('error', this._onEnded);
      this._armedVideo.loop = true; // restore normal carousel looping
      this._armedVideo = null;
      this._onEnded = null;
    }
  }

  _shuffled() {
    const a = Array.from({ length: this.ctx.count }, (_, i) => i);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ── Bottom control bar ────────────────────────────────────────────────────
  _buildBar() {
    if (this._bar) return;
    const bar = document.createElement('div');
    bar.className = 'slideshow-bar';
    bar.innerHTML = `
      <div class="slideshow-stepper">
        <button type="button" class="slideshow-bar-btn" data-step="-1" aria-label="Slower">${MINUS_SVG}</button>
        <span class="slideshow-interval" aria-live="polite">${this.interval}s</span>
        <button type="button" class="slideshow-bar-btn" data-step="1" aria-label="Faster">${PLUS_SVG}</button>
      </div>
      <button type="button" class="slideshow-bar-btn slideshow-shuffle${this.shuffle ? ' active' : ''}"
              aria-label="Shuffle" aria-pressed="${this.shuffle}">${SHUFFLE_SVG}</button>`;
    // Keep taps on the bar from reaching the viewer's close/hide handler.
    bar.addEventListener('click', (e) => e.stopPropagation());
    bar.querySelectorAll('[data-step]').forEach((b) =>
      b.addEventListener('click', () => this._changeInterval(parseInt(b.dataset.step, 10))),
    );
    this._intervalLabel = bar.querySelector('.slideshow-interval');
    this._shuffleBtn = bar.querySelector('.slideshow-shuffle');
    this._shuffleBtn.addEventListener('click', () => this._toggleShuffle());
    this.wrapper.appendChild(bar);
    this._bar = bar;
  }

  _removeBar() {
    this._bar?.remove();
    this._bar = null;
    this._intervalLabel = null;
    this._shuffleBtn = null;
  }

  _changeInterval(delta) {
    this.interval = clampInterval(this.interval + delta);
    localStorage.setItem('slideshow.interval', String(this.interval));
    if (this._intervalLabel) this._intervalLabel.textContent = `${this.interval}s`;
    this._arm(); // apply live
  }

  _toggleShuffle() {
    this.shuffle = !this.shuffle;
    localStorage.setItem('slideshow.shuffle', this.shuffle ? 'true' : 'false');
    this.order = this._shuffled();
    this._shuffleBtn?.classList.toggle('active', this.shuffle);
    this._shuffleBtn?.setAttribute('aria-pressed', String(this.shuffle));
  }

  // ── Auto-hide chrome + tab visibility ─────────────────────────────────────
  // User activity reshows the chrome; deliberate nav (keyboard/touch) also
  // resets the advance timer from the new slide so a manual jump doesn't
  // double-advance. The viewer owns arrow-key navigation; we only listen.
  _activity(resetAdvance) {
    this._showChrome();
    this._resetInactivity();
    // Only deliberate navigation resets the advance timer — mouse movement must
    // never delay the next slide (otherwise the show stalls while the pointer moves).
    if (resetAdvance && running) this._arm();
  }

  _resetInactivity() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._hideChrome(), IDLE_MS);
  }

  _showChrome() {
    document.body.classList.remove('ui-hidden');
  }

  _hideChrome() {
    if (running) document.body.classList.add('ui-hidden');
  }

  _visibility() {
    if (document.hidden) {
      this._disarm(); // pause advancing while the tab is hidden
      this._paused = true;
    } else if (this._paused) {
      this._paused = false;
      if (running) this._arm();
    }
  }
}
