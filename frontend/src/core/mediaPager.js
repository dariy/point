import { raw } from "../utils/helpers.js";
import { html } from "../utils/helpers.js";
/**
 * MediaPager — the gesture layer for the admin media grid (/light/media).
 *
 * The public grids get swipe pagination and pinch-zoom from core/gridPager.js;
 * this gives the media library the same two gestures. It is a sibling of
 * GridPager rather than a generalisation of it because the parts that differ are
 * most of it: GridPager navigates routes, renders PostCards and drives gridFit's
 * per_page arithmetic, none of which the media browser has (its pages are
 * component state, its cards are MediaBrowser markup, and its capacity is
 * measured by MediaBrowser._gridCapacity). What the two genuinely share — the
 * touch recognisers — already lives in core/gestures.js, so both read the same
 * gesture state machine and only the wiring here is new.
 *
 * The host (MediaBrowser) owns the data and hands the pager four things:
 *
 *   fetchPage(page)  → markup for a neighbouring page, for the preload ghost
 *   gotoPage(page)   → load that page
 *   onZoomCommit()   → refit per_page to the new column count
 *   isAlive()        → false once the host has unmounted
 *
 * Lifecycle, mirroring the host's own:
 *
 *   arm(pagination, key)  after each grid render — (re)binds listeners, and when
 *                         `key` changes, re-preloads the neighbouring pages
 *   destroy()             on unmount
 *
 * The swipe hand-off is the subtle part, and it is why the ghosts are parked on
 * <body> rather than inside the browser's own markup: MediaBrowser re-renders
 * its whole container on every setState, so a ghost living in there would be
 * destroyed by the very load the committed swipe just triggered. Held on the
 * body and positioned over the grid's box, the committed ghost stays on screen
 * across the load — spinner and all — until arm() drops it once the real grid is
 * underneath.
 */

import { GestureController, TrackpadDetector, rubberBand } from './gestures.js';

// "Zoom" is a chosen column count, sticky per browser like the public grid's.
const ZOOM_KEY = 'mediaGridZoom';
const MIN_CARD_PX = 110; // thumbnails shouldn't shrink narrower than this
const MAX_COLS = 12;

/** The stored media-grid zoom (column count), or 0 when unset (auto layout). */
export function getMediaZoom() {
  const v = parseInt(localStorage.getItem(ZOOM_KEY), 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Persist a zoom column count; 0/falsy clears it back to auto. */
export function setMediaZoom(cols) {
  if (cols > 0) localStorage.setItem(ZOOM_KEY, String(cols));else localStorage.removeItem(ZOOM_KEY);
}
export class MediaPager {
  /**
   * @param {object} opts
   * @param {() => HTMLElement|null} opts.root      gesture root (.media-browser)
   * @param {() => HTMLElement|null} opts.area      the element that slides (#mb-media-area)
   * @param {() => HTMLElement|null} opts.grid      the live .media-grid
   * @param {(page:number) => Promise<string>} opts.fetchPage  neighbour page markup
   * @param {(page:number) => void} opts.gotoPage   load a page
   * @param {() => void} opts.onZoomCommit          refit per_page after a zoom step
   * @param {() => boolean} opts.isAlive            false once the host unmounted
   */
  constructor(opts) {
    this._o = opts;
    this._ghosts = {
      prev: null,
      next: null
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Bind to a freshly rendered grid. Safe to call repeatedly — MediaBrowser
   * re-renders once per referring-posts lookup, so this runs many times per
   * load; every previous binding is torn down first and the neighbour preload
   * is skipped unless `key` says the listing itself changed.
   *
   * @param {{page:number, pages:number}} pagination
   * @param {string} key  identity of the current listing (page + filters)
   */
  arm(pagination, key) {
    this._teardown(); // also releases the swipe lock a commit armed
    this._pagination = pagination || {};
    this.applyZoom();
    this._setupGestures();
    this._setupPageControls();
    this._setupZoomInputs();
    // The real grid is on screen now, so a ghost held across the load can go.
    this._finishHandoff();
    if (key !== this._ghostKey) {
      this._ghostKey = key;
      this._clearGhosts();
      this._preloadAdjacent();
    }
  }
  destroy() {
    this._teardown();
    this._clearGhosts();
    this._committedGhost?.remove();
    this._committedGhost = null;
  }

  /** Remove every listener and arrow this pager owns; ghosts survive (see arm). */
  _teardown() {
    this._gesture?.destroy();
    this._gesture = null;
    this._trackpad?.destroy();
    this._trackpad = null;
    if (this._touchEl) {
      this._touchEl.removeEventListener('touchstart', this._onTouchDown);
      this._touchEl = null;
    }
    if (this._onKeyNav) {
      window.removeEventListener('keydown', this._onKeyNav);
      this._onKeyNav = null;
    }
    for (const a of this._navArrows || []) a.remove();
    this._navArrows = null;
    this._stride = null;
    this._teardownZoomInputs();
    this._endPageNav();
  }

  /**
   * Drop the committed ghost now that the real grid is rendered beneath it.
   * Removing it in the same frame reveals the grid before its thumbnails have
   * decoded — a flash of blank tiles. Holding it two frames lets the browser
   * paint the real grid underneath first.
   */
  _finishHandoff() {
    const ghost = this._committedGhost;
    this._committedGhost = null;
    if (!ghost) return;
    requestAnimationFrame(() => requestAnimationFrame(() => ghost.remove()));
  }

  // ── Swipe / trackpad pagination ────────────────────────────────────────────

  _setupGestures() {
    const root = this._o.root();
    if (!root) return;
    const pag = this._pagination;
    const atStart = () => (pag.page || 1) <= 1;
    const atEnd = () => (pag.page || 1) >= (pag.pages || 1);
    this._gesture = new GestureController(root, {
      // Engage the drag a touch sooner than the immersive default so the grid
      // starts tracking the finger promptly instead of feeling laggy.
      commitThresholdPx: 8,
      // Regions that own their own horizontal drag or their own text selection:
      // the folder chip strip scrolls sideways, and the EXIF editor and the
      // selection toolbar are full of controls.
      ignoreSelector: '.mb-folder-chips, .exif-panel, .mb-selection-bar',
      onPinchMove: scaleDelta => this._pinchStep(scaleDelta),
      onPinchEnd: () => this._onPinchEnd(),
      onSwipeMove: (dx, dy) => {
        // A commit is already animating to the next page; ignore new drags
        // until it settles so a second commit can't orphan the first's ghost.
        if (this._pageNavPending) return;
        if (Math.abs(dx) <= Math.abs(dy)) return;
        const area = this._o.area();
        if (!area) return;
        const dir = dx < 0 ? 'next' : 'prev';
        const blocked = dir === 'next' && atEnd() || dir === 'prev' && atStart();
        const tx = blocked ? rubberBand(dx) : dx;
        const stride = this._cachedStride();
        const ratio = Math.min(1, Math.abs(tx) / stride);
        area.classList.add('mb-swiping');
        area.style.transition = 'none';
        area.style.transform = `translateX(${tx}px)`;

        // Slide the preloaded neighbour in from the opposite edge in lockstep —
        // the same "infinite stripe" feel as the public grid. With a real
        // neighbour revealed the outgoing grid fades fully out; otherwise keep a
        // floor so a blocked edge drag never blanks the area.
        const ghost = blocked ? null : this._ghosts[dir];
        area.style.opacity = String(ghost ? Math.max(0, 1 - ratio) : Math.max(blocked ? 0.85 : 0.2, 1 - ratio));
        this._clearOtherPeek(dir);
        if (ghost) {
          const offset = dir === 'next' ? stride : -stride;
          ghost.style.transition = 'none';
          ghost.style.transform = `translateX(${offset + tx}px)`;
          ghost.style.opacity = String(ratio);
          this._peekGhost = ghost;
        }
      },
      onSwipeCancel: () => this._resetSwipe(),
      onSwipeCommit: dir => {
        // Only horizontal swipes paginate; a vertical one scrolled the grid.
        if (dir !== 'left' && dir !== 'right') return;
        if (this._pageNavPending) return;
        const d = dir === 'left' ? 'next' : 'prev';
        if (d === 'next' && atEnd() || d === 'prev' && atStart()) this._resetSwipe();else this._commitPageSwipe(d);
      }
    });
    this._trackpad = new TrackpadDetector(root, {
      onHorizontal: dir => {
        if (this._pageNavPending) return;
        if (dir === 'left' && !atEnd()) this._o.gotoPage(pag.page + 1);else if (dir === 'right' && !atStart()) this._o.gotoPage(pag.page - 1);
      }
    });

    // Cache the slide stride and re-anchor the ghosts at touch-down, so no
    // touchmove frame has to measure layout (the read would thrash against the
    // transform write) and a ghost preloaded before a scroll or resize still
    // lines up with the grid it slides over.
    this._onTouchDown = () => {
      this._stride = this._measureStride();
      this._positionGhosts();
    };
    root.addEventListener('touchstart', this._onTouchDown, {
      passive: true
    });
    this._touchEl = root;
  }

  /**
   * The off-screen slide distance: the grid area's width plus the grid's column
   * gap. Driving every neighbour position (rest, drag, reset, commit) from one
   * value keeps the gap between outgoing and incoming grids symmetric in both
   * directions.
   */
  _measureStride() {
    const area = this._o.area();
    const w = area?.offsetWidth || window.innerWidth || 500;
    const grid = this._o.grid();
    let gap = 0;
    if (grid) {
      const cg = parseFloat(window.getComputedStyle(grid).columnGap);
      if (!Number.isNaN(cg)) gap = cg;
    }
    return w + gap;
  }

  /** The stride cached at touch-down, measured on demand if there wasn't one. */
  _cachedStride() {
    return this._stride || (this._stride = this._measureStride());
  }

  // ── Neighbour preloading + swipe peek ──────────────────────────────────────

  /**
   * Render the previous/next page into an off-screen ghost, so a swipe reveals
   * the real neighbouring page (not a spinner) and a committed swipe hands off
   * to it seamlessly. Mirrors GridPager._preloadAdjacentGrids.
   */
  async _preloadAdjacent() {
    const pag = this._pagination;
    if (!pag || (pag.pages || 1) <= 1) return;
    const version = this._ghostVersion = (this._ghostVersion || 0) + 1;
    const build = async dir => {
      const page = dir === 'next' ? pag.page + 1 : pag.page - 1;
      if (page < 1 || page > pag.pages) return;
      let _html;
      try {
        _html = await this._o.fetchPage(page);
      } catch {
        return;
      }
      if (!this._o.isAlive() || version !== this._ghostVersion) return;
      const el = document.createElement('div');
      el.className = 'mb-page-ghost';
      el.dataset.edge = dir;
      el.innerHTML = html`${raw(_html)}`;
      document.body.appendChild(el);
      this._ghosts[dir] = el;
      this.applyZoom(); // the ghost is on <body> and inherits no zoom of its own
      this._anchorGhost(el);
    };
    await Promise.all([build('prev'), build('next')]);
  }

  /**
   * Pin a ghost over the live grid area's visible box and park it one full
   * stride off-screen. The box is clipped to the viewport: on a phone the area
   * is a document-flow element taller than the screen, and a ghost that tall
   * would slide a strip of off-screen markup past the user's thumb.
   */
  _anchorGhost(el) {
    const area = this._o.area();
    if (!area || !el) return;
    const r = area.getBoundingClientRect();
    const top = Math.max(0, r.top);
    const bottom = Math.min(r.bottom, window.innerHeight);
    el.style.top = `${top}px`;
    el.style.left = `${r.left}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${Math.max(0, bottom - top)}px`;
    const stride = this._cachedStride();
    el.style.transition = 'none';
    el.style.transform = `translateX(${el.dataset.edge === 'next' ? stride : -stride}px)`;
    el.style.opacity = '0';
  }

  /** Re-anchor both resting ghosts (the one peeking mid-drag is left alone). */
  _positionGhosts() {
    for (const dir of ['prev', 'next']) {
      const el = this._ghosts[dir];
      if (el && el !== this._peekGhost) this._anchorGhost(el);
    }
  }

  /** Remove the off-screen ghosts and invalidate any in-flight preload. */
  _clearGhosts() {
    this._ghostVersion = (this._ghostVersion || 0) + 1;
    for (const dir of ['prev', 'next']) {
      this._ghosts[dir]?.remove();
      this._ghosts[dir] = null;
    }
    this._peekGhost = null;
  }

  /** Snap a ghost peeking from the wrong side back off-screen instantly. */
  _clearOtherPeek(dir) {
    const g = this._peekGhost;
    if (g && g.dataset.edge !== dir) {
      const stride = this._cachedStride();
      g.style.transition = 'none';
      g.style.transform = `translateX(${g.dataset.edge === 'next' ? stride : -stride}px)`;
      g.style.opacity = '0';
      this._peekGhost = null;
    }
  }

  /** Animate the grid area back and settle the peeking ghost off-screen. */
  _resetSwipe() {
    const area = this._o.area();
    if (area) {
      area.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      area.style.transform = '';
      area.style.opacity = '';
      area.classList.remove('mb-swiping');
    }
    const g = this._peekGhost;
    if (g) {
      const stride = this._cachedStride();
      g.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      g.style.transform = `translateX(${g.dataset.edge === 'next' ? stride : -stride}px)`;
      g.style.opacity = '0';
      this._peekGhost = null;
    }
  }

  /** Arm the swipe lock with a watchdog that self-clears if no load follows. */
  _beginPageNav() {
    this._pageNavPending = true;
    clearTimeout(this._pageNavWatchdog);
    // Safety net: an aborted load (fetch error, unmount) never reaches arm(),
    // so auto-release rather than freeze swipes forever.
    this._pageNavWatchdog = setTimeout(() => {
      this._pageNavPending = false;
      this._resetSwipe();
    }, 3000);
  }
  _endPageNav() {
    this._pageNavPending = false;
    clearTimeout(this._pageNavWatchdog);
  }

  /**
   * Carry a committed swipe to rest: the grid area finishes sliding off while
   * the preloaded neighbour slides to centre, then the load runs under it — the
   * new page renders beneath the ghost and arm() drops the ghost, so the motion
   * flows unbroken with no spinner blink.
   */
  _commitPageSwipe(dir) {
    const pag = this._pagination;
    const targetPage = dir === 'next' ? pag.page + 1 : pag.page - 1;
    const ghost = this._ghosts[dir];
    this._beginPageNav();

    // No preloaded page yet (slow network / just landed): plain load.
    if (!ghost) {
      this._resetSwipe();
      this._o.gotoPage(targetPage);
      return;
    }
    const area = this._o.area();
    const stride = this._cachedStride();
    const T = 'transform 0.28s ease-out, opacity 0.28s ease-out';
    if (area) {
      area.style.transition = T;
      area.style.transform = `translateX(${dir === 'next' ? -stride : stride}px)`;
      area.style.opacity = '0';
    }
    ghost.style.transition = T;
    ghost.style.transform = 'translateX(0)';
    ghost.style.opacity = '1';

    // Hold this ghost on screen across the load; arm() drops it once the real
    // grid is rendered underneath.
    this._committedGhost = ghost;
    this._ghosts[dir] = null;
    this._peekGhost = null;
    // The ghost is the page we are about to be on, so its identity is stale —
    // force a fresh preload on the next arm() even if the key were to match.
    this._ghostKey = null;
    setTimeout(() => {
      if (!this._o.isAlive()) return;
      this._o.gotoPage(targetPage);
    }, 280);
  }

  // ── Pinch / wheel / keyboard zoom ──────────────────────────────────────────
  // Pinch arrives via GestureController's onPinchMove; the desktop paths
  // (ctrl+wheel, Safari's gesture* events, +/- keys) funnel into _zoomBy.
  //
  // A zoom step only re-flows the grid via CSS (instant, no reload). The
  // per_page refit — which refetches and re-renders, tearing down this very
  // gesture controller — is deferred: flushed on onPinchEnd, and debounced for
  // the discrete wheel/key paths. Refitting on every step would destroy the
  // in-flight pinch mid-gesture, so the zoom would appear frozen after one step.

  /** Widest sensible column count for the current grid width. */
  _maxCols() {
    const w = this._o.grid()?.clientWidth || this._o.area()?.clientWidth || 0;
    if (!w) return MAX_COLS;
    return Math.max(1, Math.min(MAX_COLS, Math.floor(w / MIN_CARD_PX)));
  }
  _clampCols(cols) {
    return Math.max(1, Math.min(cols, this._maxCols()));
  }

  /** Live column count of the rendered grid (from its resolved template). */
  _liveCols() {
    const grid = this._o.grid();
    if (!grid) return 0;
    const cs = window.getComputedStyle(grid);
    return cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length || 0;
  }

  /**
   * Reflect the stored zoom onto the DOM: an `is-zoomed` class plus a
   * `--media-grid-cols` var that the CSS reads to pin the column count. Stamped
   * on the live browser root *and* every ghost, since the ghosts live on <body>
   * and so inherit nothing from it. Clamped to the current width so a phone
   * never inherits a desktop's 8-column choice. Idempotent.
   */
  applyZoom() {
    const cols = getMediaZoom();
    const targets = [this._o.root(), this._ghosts.prev, this._ghosts.next, this._committedGhost];
    for (const el of targets) {
      if (!el) continue;
      if (cols) {
        el.classList.add('is-zoomed');
        el.style.setProperty('--media-grid-cols', String(this._clampCols(cols)));
      } else {
        el.classList.remove('is-zoomed');
        el.style.removeProperty('--media-grid-cols');
      }
    }
  }

  /** Accumulate incremental pinch scale and step a column once it crosses ±40%. */
  _pinchStep(scaleDelta) {
    this._pinchAccum = (this._pinchAccum || 1) * scaleDelta;
    if (this._pinchAccum > 1.4) {
      this._zoomBy(-1);
      this._pinchAccum = 1;
    } // spread → bigger thumbs, fewer cols
    else if (this._pinchAccum < 1 / 1.4) {
      this._zoomBy(1);
      this._pinchAccum = 1;
    } // pinch → smaller thumbs, more cols
  }
  _onPinchEnd() {
    this._pinchAccum = 1;
    this._commitZoom(); // gesture's over — safe to refetch/re-render now
  }

  /** Apply a ±1 column zoom step: instant CSS re-flow, deferred per_page refit. */
  _zoomBy(delta) {
    // Seed from the grid's current column count the first time, so the first
    // pinch continues from what is on screen rather than jumping.
    const current = this._clampCols(getMediaZoom() || this._liveCols() || 1);
    setMediaZoom(this._clampCols(current + delta));
    this.applyZoom();
    clearTimeout(this._zoomCommitTimer);
    this._zoomCommitTimer = setTimeout(() => this._commitZoom(), 250);
  }

  /** Refit per_page to the new column count — the re-rendering step. */
  _commitZoom() {
    clearTimeout(this._zoomCommitTimer);
    this._o.onZoomCommit?.();
  }
  _setupZoomInputs() {
    this._teardownZoomInputs();
    const root = this._o.root();
    if (!root) return;
    this._onZoomKey = e => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this._zoomBy(-1);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        this._zoomBy(1);
      }
    };
    window.addEventListener('keydown', this._onZoomKey);

    // Trackpad pinch on Chrome/Firefox/Edge arrives as a wheel event with ctrlKey.
    this._onZoomWheel = e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Trackpad pinches stream many tiny deltas — accumulate so one step needs
      // a deliberate gesture. A discrete mouse-wheel notch still steps at once.
      if (Math.sign(e.deltaY) !== Math.sign(this._wheelAccum || 0)) this._wheelAccum = 0;
      this._wheelAccum = (this._wheelAccum || 0) + e.deltaY;
      if (Math.abs(this._wheelAccum) >= 100) {
        this._zoomBy(this._wheelAccum > 0 ? 1 : -1);
        this._wheelAccum = 0;
      }
    };
    // Desktop Safari does NOT send ctrl+wheel for a trackpad pinch — it fires
    // its own gesture* events with a cumulative `scale`.
    this._onGestureStart = e => {
      e.preventDefault();
      this._gestureScale = 1;
    };
    this._onGestureChange = e => {
      e.preventDefault();
      const rel = e.scale / (this._gestureScale || 1);
      if (rel > 1.4) {
        this._zoomBy(-1);
        this._gestureScale = e.scale;
      } else if (rel < 1 / 1.4) {
        this._zoomBy(1);
        this._gestureScale = e.scale;
      }
    };
    this._onGestureEnd = e => {
      e.preventDefault();
      this._commitZoom();
    };
    this._zoomWheelEl = root;
    root.addEventListener('wheel', this._onZoomWheel, {
      passive: false
    });
    root.addEventListener('gesturestart', this._onGestureStart, {
      passive: false
    });
    root.addEventListener('gesturechange', this._onGestureChange, {
      passive: false
    });
    root.addEventListener('gestureend', this._onGestureEnd, {
      passive: false
    });
  }
  _teardownZoomInputs() {
    if (this._onZoomKey) window.removeEventListener('keydown', this._onZoomKey);
    this._onZoomKey = null;
    if (this._zoomWheelEl) {
      this._zoomWheelEl.removeEventListener('wheel', this._onZoomWheel);
      this._zoomWheelEl.removeEventListener('gesturestart', this._onGestureStart);
      this._zoomWheelEl.removeEventListener('gesturechange', this._onGestureChange);
      this._zoomWheelEl.removeEventListener('gestureend', this._onGestureEnd);
    }
    clearTimeout(this._zoomCommitTimer);
    this._onZoomWheel = null;
    this._zoomWheelEl = null;
  }

  // ── Keyboard + mouse page navigation ───────────────────────────────────────
  // Complements swipe/trackpad: arrows (and hjkl-style keys) everywhere, plus
  // the edge chevrons shared with the admin post list — a mouse path for
  // paginated listings, hidden for coarse pointers, which swipe instead.

  _setupPageControls() {
    const pag = this._pagination;
    const pages = pag.pages || 1;
    const page = pag.page || 1;
    const goPrev = () => {
      if (page > 1) this._o.gotoPage(page - 1);
    };
    const goNext = () => {
      if (page < pages) this._o.gotoPage(page + 1);
    };
    this._onKeyNav = e => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      // Up/Down are left to the browser so vertical scrolling still works.
      if (e.key === 'ArrowLeft' || e.key === 'h' || e.key === 'k') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'j') {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', this._onKeyNav);
    const CHEVRON = d => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    this._navArrows = [['prev', goPrev, 'Previous page', 'M15 18l-6-6 6-6'], ['next', goNext, 'Next page', 'M9 18l6-6-6-6']].map(([dir, go, label, d]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `page-nav-arrow admin-page-nav-arrow page-nav-${dir}`;
      b.setAttribute('aria-label', label);
      b.innerHTML = html`${raw(CHEVRON(d))}`;
      b.disabled = dir === 'prev' ? page <= 1 : page >= pages;
      b.addEventListener('click', go);
      document.body.appendChild(b);
      return b;
    });
  }
}

/** True when the event target is a field the user is typing into. */
function isTyping(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}