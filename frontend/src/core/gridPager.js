import { html, setHTML } from "../utils/helpers.js";
/**
 * GridPager — the gesture layer for a paginated post grid.
 *
 * Everything that makes a public grid feel like a deck of pages rather than a
 * document lives here: horizontal swipe with a preloaded neighbour sliding in
 * under the finger, trackpad two-finger flicks, arrow/hjkl keys, hover chevrons,
 * and pinch-to-zoom (plus its desktop equivalents — ctrl+wheel, Safari's
 * gesture* events, the footer slider and +/- keys).
 *
 * It was extracted from HomePage, which grew it; TagPage and SearchPage share it
 * rather than each keeping a copy that drifts. The host page owns the data and
 * the grid itself and hands the pager four things:
 *
 *   fetchPosts(page)  → the neighbour page's posts, for the preload ghost
 *   gotoPage(page)    → however that page navigates (usually ViewContext.update)
 *   onZoomCommit()    → refit per_page to the new column count (remounting step)
 *   isAlive()         → false once the host has unmounted
 *
 * Lifecycle, mirroring the host's own:
 *
 *   arm(pagination)    after each grid mount — (re)binds listeners, preloads the
 *                      neighbouring pages, promotes the compositor layer
 *   takeSeamless()     did this refresh come from a committed swipe?
 *   finishHandoff()    drop the committed ghost once the real grid is underneath
 *   destroy()          on unmount
 *
 * The swipe hand-off is the subtle part. A committed swipe animates the ghost to
 * centre and *keeps it there* across the route change; the host then mounts the
 * real grid underneath and calls finishHandoff(), so the motion never breaks for
 * a reload blink.
 */

import { PostCard } from '../components/public/PostCard.js';
import { Pagination } from '../components/shared/Pagination.js';
import { GestureController, TrackpadDetector, rubberBand } from './gestures.js';
import { getSettings } from '../store.js';
import { stepZoom, requestZoom, zoomCapacity, cardImageSizes } from '../utils/gridFit.js';
import { thumbSrcset } from '../utils/mediaUrl.js';
import { dropBrokenImages } from '../utils/helpers.js';
import { flipGrid } from '../utils/gridFlip.js';
export class GridPager {
  /**
   * @param {object} opts
   * @param {() => HTMLElement|null} opts.gridMount    the live #grid-mount
   * @param {() => HTMLElement|null} opts.gestureRoot  element listeners bind to (.site-main)
   * @param {(page:number) => Promise<object[]>} opts.fetchPosts  neighbour page's posts
   * @param {(page:number) => void} opts.gotoPage      navigate to a page
   * @param {() => void} opts.onZoomCommit             refit per_page after a zoom step
   * @param {() => boolean} opts.isAlive               false once the host unmounted
   * @param {(post:object, page:number) => object} [opts.cardProps]  extra PostCard props
   * @param {import('../utils/helpers.js').RawHtml} [opts.emptyHtml]  ghost
   *   markup for an empty page, built with html``
   * @param {boolean} [opts.zoom=true]                 offer pinch/slider zoom
   */
  constructor(opts) {
    this._o = {
      emptyHtml: html`<p class="empty-state">No posts yet.</p>`,
      zoom: true,
      ...opts
    };
    this._pageGhosts = {
      prev: null,
      next: null
    };
    /**
     * Media URLs already prefetched, so a repaint of the same page does not
     * queue them a second time.
     * @type {Set<string>|null}
     */
    this._warmedMedia = null;
  }

  /**
   * The leftmost page of a paginated feed. Normally 1; the home feed hands the
   * owner a lower bound (0, -1, …) so the scheduled queue can be swiped into
   * from page 1 as if it were simply more of the same deck.
   */
  static minPage(pagination) {
    const m = pagination?.minPage ?? pagination?.min_page;
    return Number.isInteger(m) && m < 1 ? m : 1;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Bind to a freshly mounted grid. Safe to call repeatedly — every previous
   * binding is torn down first, which is what makes it the single entry point
   * after both a full render and an in-place refresh.
   */
  arm(pagination) {
    this._teardown(); // also releases the swipe lock a commit armed
    this._pagination = pagination || {};
    this._pagination.minPage = GridPager.minPage(this._pagination);
    this._setupGestures();
    this._setupPageControls();
    if (this._o.zoom) this._setupZoomInputs();
    this._preloadAdjacentGrids();
    this._promoteGridAhead();
  }

  /** Clear the inline styles a swipe left on the mount, before the grid remounts. */
  resetGridStyles() {
    const gm = this._o.gridMount();
    if (!gm) return;
    gm.style.transform = '';
    gm.style.opacity = '';
    gm.style.transition = '';
  }

  /** True while a drag has the grid offset — the host skips its crossfade then. */
  isMidSwipe() {
    return !!this._o.gridMount()?.style.transform;
  }

  /** Consume the "this refresh came from a committed swipe" flag (one-shot). */
  takeSeamless() {
    const s = this._seamlessSwipe;
    this._seamlessSwipe = false;
    return s;
  }

  /**
   * Drop the committed ghost now that the real grid is mounted beneath it.
   * Removing it in the same frame revealed the grid before its card images had
   * decoded — a flash of blank cards, the "re-mount" blink on release. Holding
   * it two frames lets the browser paint the identical real grid underneath
   * first.
   */
  finishHandoff() {
    const ghost = this._committedGhost;
    this._committedGhost = null;
    if (!ghost) return;
    requestAnimationFrame(() => requestAnimationFrame(() => ghost.remove()));
  }

  /** Release every listener and ghost, leaving the pager reusable via arm(). */
  disarm() {
    this._teardown();
  }
  destroy() {
    this._teardown();
    this._committedGhost?.remove();
    this._committedGhost = null;
    if (this._o.zoom) {
      // Drop the zoom class so grids on other pages aren't squared; the
      // preference lives in localStorage and re-applies on the next mount.
      document.body.classList.remove('grid-zoom');
      document.body.style.removeProperty('--posts-grid-cols');
    }
  }

  /** Remove every listener, arrow and ghost this pager owns. */
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
    this._clearPageGhosts();
  }

  // ── Swipe / trackpad pagination ────────────────────────────────────────────

  _setupGestures() {
    // Always capture horizontal swipes (even on single-page lists) so they
    // rubber-band instead of triggering browser history back/forward.
    const root = this._o.gestureRoot();
    if (!root) return;
    const pag = this._pagination;
    const vw = () => window.innerWidth || 500;
    const atEnd = () => pag.page >= pag.pages;
    const atStart = () => pag.page <= GridPager.minPage(pag);
    this._gesture = new GestureController(root, {
      // Engage the drag a touch sooner than the immersive default so the grid
      // starts tracking the finger promptly instead of feeling laggy.
      commitThresholdPx: 8,
      onPinchMove: this._o.zoom ? scaleDelta => this._pinchStep(scaleDelta) : undefined,
      onPinchEnd: this._o.zoom ? () => this._onPinchEnd() : undefined,
      onSwipeMove: (dx, dy) => {
        // A commit is already animating to the next page; ignore new drags until
        // it settles so a second commit can't orphan the first's ghost overlay.
        if (this._pageNavPending) return;
        if (Math.abs(dx) <= Math.abs(dy)) return;
        const gridMount = this._o.gridMount();
        if (!gridMount) return;
        const dir = dx < 0 ? 'next' : 'prev';
        const blocked = dir === 'next' && atEnd() || dir === 'prev' && atStart();
        const tx = blocked ? rubberBand(dx) : dx;
        const ratio = Math.abs(tx) / vw();
        gridMount.style.transition = 'none';
        gridMount.style.transform = `translateX(${tx}px)`;

        // Slide the preloaded neighbour grid in from the opposite edge, in
        // lockstep with the outgoing grid — the same "infinite stripe" feel as
        // the immersive post-to-post swipe. With a real neighbour revealed the
        // outgoing grid fades fully out; otherwise keep a floor so a blocked
        // edge drag never blanks the screen.
        const ghost = blocked ? null : this._pageGhost(dir);
        gridMount.style.opacity = String(ghost ? Math.max(0, 1 - ratio) : Math.max(blocked ? 0.85 : 0.2, 1 - ratio));
        this._clearOtherPeek(dir);
        if (ghost) {
          // One symmetric stride (grid width + the inter-column gap) drives the
          // neighbour in from either edge, so the gap between the outgoing and
          // incoming grids is identical in both directions. Use the value cached
          // at touch-down — never measure layout here, or the per-frame
          // offsetWidth read thrashes against the transform write.
          const stride = this._cachedStride();
          const offset = dir === 'next' ? stride : -stride;
          ghost.style.transition = 'none';
          ghost.style.transform = `translateX(${offset + tx}px)`;
          ghost.style.opacity = String(Math.min(1, ratio));
          ghost.style.zIndex = '10';
          this._peekGhost = ghost;
        }
      },
      onSwipeCancel: () => this._resetGridSwipe(),
      onSwipeCommit: dir => {
        // Only horizontal swipes paginate; a vertical one is a page scroll, and
        // is forwarded for whatever page-level mode wants it (see below).
        if (dir === 'up' || dir === 'down') return this._emitVerticalSwipe(dir);
        if (dir !== 'left' && dir !== 'right') return;
        if (this._pageNavPending) return;
        const d = dir === 'left' ? 'next' : 'prev';
        if (d === 'next' && atEnd() || d === 'prev' && atStart()) {
          this._resetGridSwipe();
        } else {
          this._commitPageSwipe(d);
        }
      }
    });
    this._trackpad = new TrackpadDetector(root, {
      onHorizontal: dir => {
        if (this._pageNavPending) return;
        if (dir === 'left' && pag.page < pag.pages) this._o.gotoPage(pag.page + 1);else if (dir === 'right' && pag.page > GridPager.minPage(pag)) this._o.gotoPage(pag.page - 1);
      }
    });

    // The grid's compositor layer is created ahead of time by _promoteGridAhead
    // (during idle, after render), so the costly one-off rasterization of the
    // image-heavy grid is already done before a finger ever lands. Promoting it
    // lazily — even on touchstart — left the first few drag frames blocked on
    // that raster, so the grid ignored the finger and then snapped to it.
    // Touchstart now only caches the slide stride so onSwipeMove never measures
    // layout mid-drag.
    this._onTouchDown = () => {
      this._stride = this._swipeStride();
      this._repinGhosts();
    };
    root.addEventListener('touchstart', this._onTouchDown, {
      passive: true
    });
    this._touchEl = root;
  }

  /**
   * Announce a vertical flick on the grid. The pager never paginates vertically,
   * but it owns the only gesture recogniser on a grid page, so the modes layered
   * over that page listen here rather than each binding a second controller to
   * the same touches — currently distraction-free, which raises its footer
   * overlay on a flick up and leaves the mode on a flick down.
   *
   * Only fires at the scroll extremes: mid-document the same flick is a scroll
   * and nothing else. (The gesture layer deliberately doesn't preventDefault a
   * vertical drag, so the browser scrolls in parallel either way.)
   */
  _emitVerticalSwipe(dir) {
    const y = window.scrollY || 0;
    const atTop = y <= 2;
    const atBottom = y + window.innerHeight >= document.documentElement.scrollHeight - 2;
    if (dir === 'down' ? !atTop : !atBottom) return;
    window.dispatchEvent(new CustomEvent('point:grid-swipe-vertical', {
      detail: {
        dir
      }
    }));
  }

  // Keyboard + mouse page navigation for the grid, complementing swipe/trackpad.
  // Keyboard works in every mode (arrows + hjkl-style); the edge arrows provide
  // a mouse path for paginated grids (revealed on hover for fine pointers only
  // — touch users swipe).
  _setupPageControls() {
    const pag = this._pagination;
    const pages = pag.pages || 1;
    const minPage = GridPager.minPage(pag);
    const goPrev = () => {
      if (pag.page > minPage) this._o.gotoPage(pag.page - 1);
    };
    const goNext = () => {
      if (pag.page < pages) this._o.gotoPage(pag.page + 1);
    };
    this._onKeyNav = e => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      // Never hijack keys while the user is typing (search box, etc.).
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // h/k = back, l/j = forward — arrow keys likewise. Up/Down are left to the
      // browser so vertical scrolling still works.
      if (e.key === 'ArrowLeft' || e.key === 'h' || e.key === 'k') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'j') {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', this._onKeyNav);
    const CHEVRON = d => html`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    /** @type {Array<[string, () => void, string, string]>} */
    const arrowSpecs = [
      ['prev', goPrev, 'Previous page', 'M15 18l-6-6 6-6'],
      ['next', goNext, 'Next page', 'M9 18l6-6-6-6'],
    ];
    this._navArrows = arrowSpecs.map(([dir, go, label, d]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `page-nav-arrow page-nav-${dir}`;
      b.setAttribute('aria-label', label);
      setHTML(b, html`${CHEVRON(d)}`);
      b.disabled = dir === 'prev' ? pag.page <= minPage : pag.page >= pages;
      b.addEventListener('click', go);
      document.body.appendChild(b);
      return b;
    });
  }

  // ── Pinch / wheel / keyboard zoom ──────────────────────────────────────────
  // Pinch is handled by GestureController's onPinchMove; here we add the desktop
  // paths: ctrl+wheel (trackpad pinch) and +/- keys. All funnel into _zoomBy.
  //
  // A zoom step only re-flows the grid via CSS (instant, no remount). The
  // per_page reconcile — which updates the route and REBUILDS the post content,
  // tearing down this very gesture controller — is deferred: flushed on
  // onPinchEnd, and debounced for the discrete wheel/key paths. Reconciling on
  // every step would destroy the in-flight pinch mid-gesture (the same trap the
  // timeline plugin documents), so the zoom would appear frozen after one step.

  /** Accumulate incremental pinch scale and step a column once it crosses ±40%. */
  _pinchStep(scaleDelta) {
    this._pinchAccum = (this._pinchAccum || 1) * scaleDelta;
    if (this._pinchAccum > 1.4) {
      this._zoomBy(-1);
      this._pinchAccum = 1;
    } // spread → bigger cards, fewer cols
    else if (this._pinchAccum < 1 / 1.4) {
      this._zoomBy(1);
      this._pinchAccum = 1;
    } // pinch → smaller cards, more cols
  }
  _onPinchEnd() {
    this._pinchAccum = 1;
    this._commitZoom(); // gesture's over — safe to refetch/remount now
  }

  /** Apply a ±1 column zoom step: instant CSS re-flow, deferred per_page refit. */
  _zoomBy(delta) {
    const grid = this._o.gridMount()?.querySelector('.posts-grid');
    if (!grid) return;
    // CSS-only: pins columns + rows + squares cards, no remount. Both halves of
    // the new geometry go inside the FLIP so the cards glide into it rather
    // than cutting to it — see utils/gridFlip.js.
    flipGrid(/** @type {HTMLElement} */ (grid), () => {
      stepZoom(grid, delta);
      this._trimToCapacity(grid);
    });
    clearTimeout(this._zoomCommitTimer);
    this._zoomCommitTimer = setTimeout(() => this._commitZoom(), 250);
  }

  /**
   * Hide the cards the stepped-to geometry has no room for.
   *
   * A step towards fewer columns makes the cards bigger, so the page that was
   * loaded no longer fits — the refit drops the tail of it a moment later.
   * Hiding those cards on the step means the grid goes straight to the shape it
   * is going to keep, instead of showing an overflowing one in between. The
   * refit clears the marks (PostGrid.reconcile), so nothing stays hidden if it
   * turns out to fit after all.
   */
  _trimToCapacity(grid) {
    const capacity = zoomCapacity();
    if (!capacity) return;
    grid.querySelectorAll('.post-card-slot').forEach((slot, i) => {
      slot.classList.toggle('is-zoom-surplus', i >= capacity);
    });
  }

  /** Refit per_page (and page) to the new column count — the remounting step. */
  _commitZoom() {
    clearTimeout(this._zoomCommitTimer);
    this._o.onZoomCommit();
  }
  _setupZoomInputs() {
    this._teardownZoomInputs();
    // Marks this page as zoom-capable — the footer slider is only shown when
    // this class is present.
    document.body.classList.add('grid-zoomable');
    // Footer slider sets an absolute column count; commit is debounced here
    // like every other zoom path.
    this._onZoomRequest = e => {
      const grid = /** @type {HTMLElement|null} */ (
        this._o.gridMount()?.querySelector('.posts-grid') ?? null
      );
      flipGrid(grid, () => {
        requestZoom(e.detail?.cols || 0, grid);
        if (grid) this._trimToCapacity(grid);
      });
      clearTimeout(this._zoomCommitTimer);
      this._zoomCommitTimer = setTimeout(() => this._commitZoom(), 250);
    };
    window.addEventListener('point:grid-zoom-request', this._onZoomRequest);
    this._onZoomKey = e => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
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
      // a deliberate gesture. A discrete mouse-wheel notch (~±100-120) still
      // steps immediately. Direction change resets the run.
      if (Math.sign(e.deltaY) !== Math.sign(this._wheelAccum || 0)) this._wheelAccum = 0;
      this._wheelAccum = (this._wheelAccum || 0) + e.deltaY;
      if (Math.abs(this._wheelAccum) >= 100) {
        this._zoomBy(this._wheelAccum > 0 ? 1 : -1);
        this._wheelAccum = 0;
      }
    };
    // Desktop Safari does NOT send ctrl+wheel for a trackpad pinch — it fires its
    // own gesturestart/change/end events with a cumulative `scale`. Handle those
    // so Safari pinch works (and preventDefault stops Safari's own page zoom).
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
      } // spread → fewer cols
      else if (rel < 1 / 1.4) {
        this._zoomBy(1);
        this._gestureScale = e.scale;
      } // pinch → more cols
    };
    this._onGestureEnd = e => {
      e.preventDefault();
      this._commitZoom();
    };
    this._zoomWheelEl = this._o.gestureRoot();
    this._zoomWheelEl?.addEventListener('wheel', this._onZoomWheel, {
      passive: false
    });
    this._zoomWheelEl?.addEventListener('gesturestart', this._onGestureStart, {
      passive: false
    });
    this._zoomWheelEl?.addEventListener('gesturechange', this._onGestureChange, {
      passive: false
    });
    this._zoomWheelEl?.addEventListener('gestureend', this._onGestureEnd, {
      passive: false
    });
  }
  _teardownZoomInputs() {
    document.body.classList.remove('grid-zoomable');
    if (this._onZoomRequest) window.removeEventListener('point:grid-zoom-request', this._onZoomRequest);
    this._onZoomRequest = null;
    if (this._onZoomKey) window.removeEventListener('keydown', this._onZoomKey);
    if (this._zoomWheelEl) {
      this._zoomWheelEl.removeEventListener('wheel', this._onZoomWheel);
      this._zoomWheelEl.removeEventListener('gesturestart', this._onGestureStart);
      this._zoomWheelEl.removeEventListener('gesturechange', this._onGestureChange);
      this._zoomWheelEl.removeEventListener('gestureend', this._onGestureEnd);
    }
    clearTimeout(this._zoomCommitTimer);
    this._onZoomKey = null;
    this._onZoomWheel = null;
    this._zoomWheelEl = null;
  }

  /**
   * Promote #grid-mount to its own compositor layer ahead of any interaction,
   * during idle time after the grid has rendered. Creating the layer (and its
   * one-off rasterization of the image-heavy grid) up front means the first
   * drag frame is just a cheap GPU transform — there's no raster stall at
   * touch-down that makes the grid lag behind the finger. translateZ(0) (via
   * the class) forces the raster now rather than merely hinting at it.
   */
  _promoteGridAhead() {
    const promote = () => this._o.gridMount()?.classList.add('grid-promoted');
    if (typeof requestIdleCallback === 'function') requestIdleCallback(promote);else requestAnimationFrame(promote);
  }

  // ── Adjacent-page preloading + swipe peek ──────────────────────────────────

  /** The preloaded ghost grid element for a drag direction, if ready. */
  _pageGhost(dir) {
    return this._pageGhosts?.[dir]?.el || null;
  }

  /**
   * How much more room the chrome below the grid takes once the paginator is
   * showing `page` — the band gridFit's belowGridReserve measures, and exactly
   * what the destination page's grid box is short by.
   *
   * The paginator's height is a function of *which* page is current: the run of
   * numbers around it widens as you move into the deck (`1 2 … 108` on page 1,
   * `1 2 3 … 108` on page 2), and where the strip runs out of width it wraps
   * onto a second line. Which paginator that happens to is a media query's
   * business, not this file's — the in-flow one below the grid on portrait
   * phones, the footer's compact copy on everything wider and on every
   * landscape viewport (css/public/footer.css) — so both mounts are measured
   * and neither is named.
   *
   * Measured by standing the destination paginator in the live one's place for
   * the length of one synchronous layout, rather than by predicting where the
   * strip wraps. Prediction would have to know the digit widths, the gap, the
   * container width and — for the footer copy — whether the paginator is even
   * the tallest thing in its row; the layout engine knows all four. Nothing
   * paints between the swap and the restore, and a ResizeObserver compares
   * against the size it last reported, so watchChromeFit never sees it.
   *
   * @param {number} page  the page the ghost is being built for.
   * @returns {number} destination band height − current band height. Negative
   *   when the destination paginator is the shorter one (swiping back towards
   *   page 1), 0 when there is nothing laid out to compare against.
   */
  _belowGridGrowth(page) {
    const mounts = ['#pagination-mount', '#footer-mount']
      .map(sel => document.querySelector(sel))
      .filter(Boolean);
    // The copy that is actually laid out; the other one is display:none and
    // measures 0, which is also what an unpaginated view measures.
    const live = /** @type {HTMLElement|undefined} */ ([...(document.querySelectorAll?.(
      '#pagination-mount .pagination, .footer-pagination .pagination') || [])]
      .find(el => el.getBoundingClientRect().height > 0));
    if (!live || !mounts.length) return 0;
    const band = () => mounts.reduce((h, m) => h + m.getBoundingClientRect().height, 0);
    const pag = this._pagination;
    const holder = document.createElement('div');
    setHTML(holder, html`${new Pagination(document.createElement('div'), {
      page,
      pages: pag.pages,
      minPage: GridPager.minPage(pag),
      total: pag.total,
      // The footer's copy is compact — the item count is a tooltip rather than
      // a label beside the strip, and that is a whole flex item of width.
      // Read off the live node so the probe matches whichever copy is on
      // screen without the pager having to know who mounted it.
      compact: !live.querySelector('.page-info')
    }).render()}`);
    const probe = holder.firstElementChild;
    if (!probe) return 0;
    const before = band();
    const display = live.style.display;
    try {
      live.style.display = 'none';
      live.parentElement.appendChild(probe);
      return band() - before;
    } finally {
      probe.remove();
      live.style.display = display;
    }
  }

  /**
   * Re-pin the parked ghosts to the live grid box as it stands *now*.
   *
   * A ghost is built moments after the grid mounts, and at that point the chrome
   * around the grid has not finished arriving: the footer is an async plugin
   * slot, so the grid is still as much as a footer taller than it will settle at
   * (56px on a 770px-wide window here). A per_page refit re-arms the pager and
   * rebuilds the ghosts against the settled layout — but a settling pass that
   * lands on the same per_page does not re-arm anything, and then the ghost
   * outlives the measurement it was cut from. That is the incoming page arriving
   * at the wrong size and snapping straight after: not the destination's chrome,
   * the *outgoing* page's, measured too early.
   *
   * Touch-down is the last moment before a slide and already where the stride is
   * cached, so the box is re-read here rather than watched: one layout read, no
   * observer, and nothing measured during the drag itself. The destination's own
   * paginator growth was measured at build time and is reused as-is — it is a
   * property of the page being slid to, not of when the question is asked.
   */
  _repinGhosts() {
    const liveGrid = this._o.gridMount();
    if (!liveGrid) return;
    const height = liveGrid.offsetHeight;
    const top = liveGrid.offsetTop;
    if (!height) return;
    for (const dir of ['prev', 'next']) {
      const ghost = this._pageGhosts?.[dir];
      if (!ghost?.el) continue;
      ghost.el.style.height = `${Math.max(0, height - (ghost.growth || 0))}px`;
      if (top) ghost.el.style.top = `${top}px`;
    }
  }

  /**
   * The off-screen slide distance for a page swipe: the live grid's width plus
   * the inter-column gap. Driving every neighbour position (rest, drag, reset,
   * commit) from this single value keeps the gap between the outgoing and
   * incoming grids symmetric in both directions and independent of the viewport
   * width vs. the padded container width.
   */
  _swipeStride() {
    const gm = this._o.gridMount();
    const w = gm?.offsetWidth || window.innerWidth || 500;
    const grid = gm?.querySelector('.posts-grid');
    let gap = 0;
    if (grid) {
      const cg = parseFloat(window.getComputedStyle(grid).columnGap);
      if (!Number.isNaN(cg)) gap = cg;
    }
    return w + gap;
  }

  /**
   * The slide stride cached at touch-down (see _setupGestures). The stride is
   * constant for the duration of a drag, so reading it from the cache avoids a
   * layout-forcing measurement on every touchmove frame; fall back to a fresh
   * measure if a code path runs without a preceding touchstart.
   */
  _cachedStride() {
    return this._stride || (this._stride = this._swipeStride());
  }

  /**
   * Preload the previous/next page and render its grid into an off-screen ghost
   * element, so a swipe reveals the real next page (not a skeleton) and a
   * committed swipe hands off to it seamlessly. Mirrors MediaViewer's
   * _preloadNeighbors for the immersive carousel.
   */
  async _preloadAdjacentGrids() {
    const pag = this._pagination;
    const liveGrid = this._o.gridMount();
    const container = liveGrid?.parentElement;
    const minPage = GridPager.minPage(pag);
    if (!container || !pag || pag.pages - minPage < 1) return;
    // The live grid stretches its cards to fill the viewport when content is
    // short (grid-expand). The ghost sits outside that flex, so pin it to the
    // live grid's box — height, and the offset of the grid within the container,
    // since a page may render chrome (search's tag chips) above the grid.
    const gridHeight = liveGrid.offsetHeight;
    const gridTop = liveGrid.offsetTop;
    const version = this._ghostVersion = (this._ghostVersion || 0) + 1;
    const build = async dir => {
      const page = dir === 'next' ? pag.page + 1 : pag.page - 1;
      if (page < minPage || page > pag.pages) return;
      // The box the *destination* page gets, though, is the live one minus
      // whatever its own paginator takes on top of the current one. Measured
      // here, before the slide, so the incoming cards are laid out once at the
      // height they will keep rather than being resized by the hand-off to the
      // real grid — see _belowGridGrowth.
      const growth = this._belowGridGrowth(page);
      const ghostHeight = gridHeight ? Math.max(0, gridHeight - growth) : 0;
      let posts;
      try {
        posts = await this._o.fetchPosts(page);
      } catch {
        return;
      }
      if (!this._o.isAlive() || version !== this._ghostVersion) return;
      const el = document.createElement('div');
      el.className = 'grid-preview-placeholder';
      el.dataset.edge = dir;
      if (ghostHeight) el.style.height = `${ghostHeight}px`;
      if (gridTop) el.style.top = `${gridTop}px`;
      setHTML(el, html`${this._buildGridHtml(posts || [], page)}`);
      // The ghost's cards are static markup with no component behind them, so
      // the one bit of card behaviour they still need is wired here: a video
      // with no poster frame must leave its card unpainted rather than paint a
      // broken-image glyph (see PostCard.afterRender).
      dropBrokenImages(el);
      container.appendChild(el);
      // Warm the neighbour cards' media now, while the ghost is parked
      // off-screen. A ghost is laid out off-screen and its cards are lazy, so
      // the browser won't fetch or decode any of it until the element is
      // actually painted — without this the first drag frame (when the ghost
      // fades in) pays the whole grid's fetch+decode+paint cost at once, which
      // is the start-of-drag hitch. Decoding ahead of time lets that first
      // frame just composite an already-rasterized layer.
      this._warmGridMedia(posts || []);
      // Rest off-screen at one full stride so the first drag frame doesn't jump.
      const stride = this._swipeStride();
      el.style.transform = `translateX(${dir === 'next' ? stride : -stride}px)`;
      el.style.opacity = '0';
      this._pageGhosts[dir] = {
        page,
        el,
        growth
      };
    };
    await Promise.all([build('prev'), build('next')]);
  }

  /**
   * Pre-fetch and pre-decode the neighbour cards' media so the first frame of a
   * swipe composites an already-rasterized ghost instead of triggering a
   * grid-wide fetch+decode+paint burst. Runs at idle so it never competes with
   * the live grid's own first paint.
   *
   * The warm-up is handed the card's whole candidate set — the same srcset and
   * the same `sizes` PostCard renders — rather than a URL of its own, so the
   * browser picks the identical rung and the card finds it already in cache.
   * Warming `media_url` bare, as this did, fetched the full original of every
   * neighbouring post: megabytes each, and not one byte of it the file the card
   * goes on to request.
   *
   * Videos are warmed too, and for the same reason: a card paints a video's
   * poster frame through the same ladder, so it is an image like any other.
   */
  _warmGridMedia(posts) {
    const urls = posts.map(p => p && p.media_url).filter(Boolean);
    if (!urls.length) return;
    const sizes = cardImageSizes();
    const warm = () => {
      for (const url of urls) {
        if (this._warmedMedia?.has(url)) continue;
        (this._warmedMedia ||= new Set()).add(url);
        const {
          src,
          srcset
        } = thumbSrcset(url, {
          sizes
        });
        const im = new Image();
        // sizes before srcset before src: the candidate is chosen when src is
        // assigned, off whatever the other two say at that moment.
        if (srcset) {
          im.sizes = sizes;
          im.srcset = srcset;
        }
        im.src = src;
        im.decode?.().catch(() => {});
      }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm);else setTimeout(warm, 0);
  }

  /** Build static grid markup (real cards, no listeners) for a ghost preview. */
  _buildGridHtml(posts, page) {
    if (!posts.length) return this._o.emptyHtml;
    /** @type {Record<string, any>} */
    const settings = getSettings() || {};
    const heroIndex = posts.findIndex(p => p.is_featured);
    const dummy = document.createElement('div');
    const slots = posts.map((post, i) => {
      const cls = i === heroIndex ? ' featured-post' : '';
      const card = new PostCard(dummy, {
        post,
        showViewCount: !!settings.show_view_counts,
        isHero: i === heroIndex,
        ...(this._o.cardProps ? this._o.cardProps(post, page) : {})
      }).render();
      return html`<div class="post-card-slot${cls}">${card}</div>`;
    });
    // The scheduled pages run the other way (see PostGrid) — a peek at one has
    // to already be reversed, or the ghost re-flows the moment it lands.
    const gridCls = page < 1 ? 'posts-grid posts-grid-reversed' : 'posts-grid';
    return html`<div class="${gridCls}">${slots}</div>`;
  }

  /** Remove the off-screen ghost grids and invalidate any in-flight preload. */
  _clearPageGhosts() {
    this._ghostVersion = (this._ghostVersion || 0) + 1;
    for (const dir of ['prev', 'next']) {
      this._pageGhosts[dir]?.el?.remove();
      this._pageGhosts[dir] = null;
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

  /** Animate the active grid back and settle the peeking ghost off-screen. */
  _resetGridSwipe() {
    const gridMount = this._o.gridMount();
    if (gridMount) {
      gridMount.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      gridMount.style.transform = '';
      gridMount.style.opacity = '1';
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

  /** Arm the swipe lock with a watchdog that self-clears if no mount follows. */
  _beginPageNav() {
    this._pageNavPending = true;
    clearTimeout(this._pageNavWatchdog);
    // Safety net: an aborted navigation (fetch error, same-page nav, unmount)
    // never reaches arm(), so auto-release rather than freeze swipes forever.
    // 3s comfortably outlasts the 280ms hand-off + a slow fetch.
    this._pageNavWatchdog = setTimeout(() => {
      this._pageNavPending = false;
      this._resetGridSwipe();
    }, 3000);
  }
  _endPageNav() {
    this._pageNavPending = false;
    clearTimeout(this._pageNavWatchdog);
  }

  /**
   * Carry a committed swipe to rest: the active grid finishes sliding off while
   * the preloaded neighbour grid slides to centre, then the route swaps under
   * it — the new page's real grid mounts beneath the ghost and the ghost is
   * dropped, so the motion flows unbroken with no reload blink.
   */
  _commitPageSwipe(dir) {
    const pag = this._pagination;
    const ghost = this._pageGhost(dir);
    const targetPage = dir === 'next' ? pag.page + 1 : pag.page - 1;

    // Lock out further swipes until the new grid mounts (or the watchdog fires).
    // Without this, a second commit during the ~280ms hand-off overwrites
    // _committedGhost and orphans the first ghost — a static overlay pinned over
    // the page that never gets removed, which reads as the page "freezing".
    this._beginPageNav();

    // No preloaded grid yet (slow network / just landed): fall back to the
    // plain crossfade by navigating straight away.
    if (!ghost) {
      this._resetGridSwipe();
      this._o.gotoPage(targetPage);
      return;
    }
    const gridMount = this._o.gridMount();
    const stride = this._cachedStride();
    const T = 'transform 0.28s ease-out, opacity 0.28s ease-out';
    if (gridMount) {
      gridMount.style.transition = T;
      gridMount.style.transform = `translateX(${dir === 'next' ? -stride : stride}px)`;
      gridMount.style.opacity = '0';
    }
    ghost.style.transition = T;
    ghost.style.transform = 'translateX(0)';
    ghost.style.opacity = '1';
    ghost.style.zIndex = '11';

    // Hold this ghost on screen across the route swap; finishHandoff() drops it
    // once the real grid is mounted underneath.
    this._committedGhost = ghost;
    this._pageGhosts[dir] = null;
    this._peekGhost = null;
    setTimeout(() => {
      if (!this._o.isAlive()) return;
      this._seamlessSwipe = true;
      this._o.gotoPage(targetPage);
    }, 280);
  }
}