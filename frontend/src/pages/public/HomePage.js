/**
 * HomePage — public blog index.
 *
 * Fetches: GET /api/pages/home
 * Layout:  header / posts-grid + tag-cloud sidebar / pagination / footer
 *
 * Props (from router): { params, query: { page } }
 */

import { Component } from '../../components/Component.js';

import { PostGrid } from '../../components/public/PostGrid.js';
import { PostCard } from '../../components/public/PostCard.js';
import { PostContent, shouldUseImmersive } from '../../components/public/PostContent.js';

import { Pagination } from '../../components/shared/Pagination.js';
import { getHomePage } from '../../api/pages.js';
import { pluginHost } from '../../core/pluginHost.js';
import { store } from '../../store.js';
import { escapeHtml, normalizeSettings } from '../../utils/helpers.js';
import { GestureController, TrackpadDetector, rubberBand } from '../../core/gestures.js';
import { ViewContext } from '../../utils/viewContext.js';
import { computePerPage, cachedPerPage } from '../../utils/gridFit.js';

export default class HomePage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, error: null, forceImmersive: false, startIndex: 0 };
  }

  onRouteUpdate(params, query) {
    const prevVc = this._loadedVc;
    this.props.params = params;
    this.props.query = query;
    const nextVc = ViewContext.current();
    // A timeline-scope or pagination change only affects the post list — refresh
    // it in place instead of re-rendering (and remounting) the whole page, which
    // would tear down and rebuild the timeline (the visible "blink").
    if (this._canPartialUpdate(prevVc, nextVc)) {
      this._refreshPostContent();
    } else {
      this._load();
    }
  }

  _isStaticHome() {
    const settings = store.get('settings') || {};
    const data = this.state.data;
    return !!(data && settings.home_page_post_id && data.pagination?.total === 1 && data.posts?.length === 1);
  }

  // Eligible when only the year scope and/or page differ: the post grid, filter
  // chips and pagination change, but the page chrome (header, tag cloud, timeline)
  // does not. A tag/query change alters that chrome, so fall back to a full render.
  _canPartialUpdate(prev, next) {
    if (!prev || !this.state.data || this.state.error) return false;
    if (this._isStaticHome()) return false;
    return prev.tag === next.tag && prev.query === next.query && prev.postSlug === next.postSlug;
  }

  async _refreshPostContent() {
    const vc = ViewContext.current();
    const gridMount = this.$('#grid-mount');

    // A swipe that committed has already slid the preloaded neighbour grid to
    // centre (the "committed ghost"); we just hand off to the real grid under
    // it with no fade. Otherwise crossfade like post-to-post navigation: fade
    // the current grid out while the next page loads, then fade the fresh grid
    // in.
    const seamless = this._seamlessSwipe;
    this._seamlessSwipe = false;
    const fromSwipe = seamless || !!(gridMount && gridMount.style.transform);

    let fadeOut = Promise.resolve();
    if (gridMount && !fromSwipe) {
      gridMount.style.transition = 'opacity 0.2s ease-in';
      gridMount.style.opacity = '0';
      fadeOut = new Promise((resolve) => setTimeout(resolve, 200));
    }

    let data;
    try {
      data = await getHomePage(this._buildParams(vc));
    } catch (err) {
      this.setState({ loading: false, data: null, error: err.message || 'Failed to load posts.' });
      return;
    }
    if (this._unmounted) return;
    await fadeOut;
    if (this._unmounted) return;
    if (data.settings) store.set('settings', { ...store.get('settings'), ...normalizeSettings(data.settings) });
    // tag_cloud is page-independent and only sent on page 1; cache it so it
    // persists across pagination, swipes, and direct loads of later pages.
    if (data.tag_cloud) store.set('tagCloud', data.tag_cloud);
    this.state.data = data;
    this.state.error = null;
    this._loadedVc = vc;
    this._clearPostContent();
    this._mountPostContent();
    this._timeline?.setScope(vc.years ? { from: vc.years[0], to: vc.years[1] } : null);
    this._timeline?.setCount(this.state.data?.pagination?.total ?? this.state.data?.total ?? 0);

    const newGrid = this.$('#grid-mount');
    if (seamless) {
      // The real grid is now mounted and centred directly under the committed
      // ghost. Removing the ghost in this same frame revealed the grid before
      // its card images had decoded/painted — a flash of blank cards, the
      // "re-mount" blink on release. Hold the ghost two frames so the browser
      // paints the identical real grid underneath first, then drop it.
      const ghost = this._committedGhost;
      this._committedGhost = null;
      requestAnimationFrame(() => requestAnimationFrame(() => ghost?.remove()));
    } else if (newGrid) {
      // Fade the freshly-mounted grid in. _mountPostContent() reset the mount's
      // inline styles, so we start from a clean opacity:0 and transition up.
      newGrid.style.transition = 'none';
      newGrid.style.opacity = '0';
      void newGrid.offsetWidth; // force reflow so the next change animates
      newGrid.style.transition = 'opacity 0.2s ease-out';
      newGrid.style.opacity = '1';
    }
  }

  _minPerPage() {
    return (store.get('settings') || {}).posts_per_page || 10;
  }

  _buildParams(vc) {
    // per_page is the device-fit value from the URL, or the cached estimate for
    // a fresh load that hasn't been reconciled against the real grid yet.
    const perPage = vc.perPage || cachedPerPage(this._minPerPage());
    this._loadedPerPage = perPage;
    const params = { page: vc.page, per_page: perPage };
    if (vc.years) {
      params.year_from = vc.years[0];
      params.year_to = vc.years[1];
    }
    if (vc.query) params.q = vc.query;
    if (vc.tag) params.tag = vc.tag;
    return params;
  }

  // Measure the rendered grid and, if the viewport fits a different number of
  // posts than we loaded, persist the new per_page to the URL — recomputing the
  // page so the first post currently shown stays visible on the resized list.
  _reconcilePerPage({ fromResize = false } = {}) {
    if (this._unmounted) return;
    const grid = this.$('.posts-grid');
    if (!grid) return; // static/immersive home has no grid to fill
    const vc = ViewContext.current();
    // An explicit per_page in the URL is reproduced as-is on load; only an
    // actual resize re-fits it to the new window.
    if (!fromResize && vc.perPage) return;
    const fit = computePerPage(this._minPerPage(), grid);
    const current = this._loadedPerPage || fit;
    if (fit === current) return;
    const firstIndex = (vc.page - 1) * current;
    const newPage = Math.floor(firstIndex / fit) + 1;
    ViewContext.update({ per_page: fit, page: newPage }, { replace: true });
  }

  _onResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this._reconcilePerPage({ fromResize: true }), 200);
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading posts…"></div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    if (error) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main">
            <p class="error-message" role="alert">${escapeHtml(error)}</p>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    const settings = store.get('settings') || {};
    const { data } = this.state;
    const isStaticHomePage = data && !!settings.home_page_post_id && data.pagination?.total === 1 && data.posts?.length === 1;

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        ${isStaticHomePage ? '' : '<div id="tag-cloud-mount"></div>'}
        ${isStaticHomePage ? '' : '<div id="timeline-mount"></div>'}
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount" class="${isStaticHomePage ? '' : 'grid-expand-mount'}"></div>
            ${isStaticHomePage ? '' : '<div id="pagination-mount"></div>'}
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    const { data, forceImmersive, startIndex } = this.state;
    const isStaticHomePage = data && !!settings.home_page_post_id && data.pagination?.total === 1 && data.posts?.length === 1;
    const post = isStaticHomePage ? data.posts[0] : null;
    const immersive = forceImmersive || (isStaticHomePage && shouldUseImmersive(post));

    if (immersive) {
      document.body.classList.add('immersive-layout');
    } else {
      document.body.classList.remove('immersive-layout', 'ui-hidden', 'immersive-overlay-sheet');
    }

    this._teardownGestures();
    const navTags = store.get('navTags') || [];

    // In immersive mode suppress the tag filter bar (post tags go in the footer instead),
    // but keep the custom menu visible since it contains explicit navigation links.
    const isCustomMenu = settings.nav_menu_mode === 'custom';
    const total = this.state.data?.pagination?.total || this.state.data?.total || 0;
    pluginHost.fill('header', this.$('#header-mount'), {
      settings,
      currentPath: '/',
      navTags: (immersive && !isCustomMenu) ? [] : navTags,
      editUrl: (isStaticHomePage && post) ? `/light/posts/${post.id}/edit` : null,
      total,
      timelineVisible: this._canShowTimeline,
      // Only the paginated grid view offers the distraction-free toggle.
      distractionToggle: !isStaticHomePage && !immersive,
    }).then(comps => {
      if (comps[0] && !this._unmounted) {
        this._headerChild = comps[0];
        this._children.push(comps[0]);
      }
    });

    const immersiveTags = (isStaticHomePage && immersive) ? (post.tags || []) : [];
    pluginHost.fill('footer', this.$('#footer-mount'), { settings, immersiveTags }).then(comps => {
      if (comps[0] && !this._unmounted) {
        this._footerChild = comps[0];
        this._children.push(comps[0]);
      }
    });

    if (this.state.loading || !this.state.data) return;

    if (isStaticHomePage) {
      this.mountChild(PostContent, '#grid-mount', {
        post: data.posts[0],
        showViewCount: !!settings.show_view_counts,
        showImmersiveExcerpt: settings.show_immersive_excerpt !== 'false',
        forceImmersive: immersive,
        startIndex: startIndex,
        onEnterImmersive: (idx = 0) => {
          const hash = idx === 0 ? "" : `#${idx + 1}`;
          window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
          this.setState({ forceImmersive: true, startIndex: idx });
        },
      });
      return;
    }

    // home-explore slot (tag cloud).
    const tagCloud = this.state.data.tag_cloud || store.get('tagCloud') || [];
    pluginHost.fill('home-explore', this.$('#tag-cloud-mount'), { tags: tagCloud, settings });

    // timeline slot.
    this._canShowTimeline = pluginHost.hasSlot('timeline');
    if (this._canShowTimeline) {
      const vc = ViewContext.current();
      pluginHost.fill('timeline', this.$('#timeline-mount'), {
        mode: 'filter',
        canShow: this._canShowTimeline,
        initialRange: vc.years ? { from: vc.years[0], to: vc.years[1] } : undefined,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
        total,
      }).then(comps => {
        if (comps[0] && !this._unmounted) {
          this._timeline = comps[0];
          this._children.push(comps[0]);
        }
      });
    }

    this._mountPostContent();
  }

  // Mounts the filter-dependent content (post grid, filter chips, pagination,
  // swipe gestures). Kept separate from the page chrome so a timeline-scope or
  // page change can refresh just this in place — see _refreshPostContent.
  _mountPostContent() {
    const settings = store.get('settings') || {};
    const { posts = [], pagination = {} } = this.state.data;

    this._postChildren = [];

    // A paginated swipe leaves an inline transform on the grid mount; clear it so
    // the refreshed grid isn't left offset.
    const gridMount = this.$('#grid-mount');
    if (gridMount) {
      gridMount.style.transform = '';
      gridMount.style.opacity = '';
      gridMount.style.transition = '';
      gridMount.classList.remove('grid-swiping');
    }

    this._postChildren.push(
      this.mountChild(PostGrid, '#grid-mount', {
        posts,
        showViewCount: !!settings.show_view_counts,
        useThumbnails: settings.use_thumbnails !== false,
      }),
    );

    if (pagination.pages > 1) {
      this._postChildren.push(
        this.mountChild(Pagination, '#pagination-mount', {
          page: pagination.page,
          pages: pagination.pages,
          total: pagination.total,
          onPage: (p) => ViewContext.update({ page: p }),
        }),
      );
    }

    this._setupGestures(pagination);
    this._preloadAdjacentGrids(pagination);
    this._promoteGridAhead();

    // After the real grid has laid out, fit per_page to the viewport.
    requestAnimationFrame(() => this._reconcilePerPage());
  }

  _clearPostContent() {
    for (const c of this._postChildren || []) {
      c.unmount();
      const i = this._children.indexOf(c);
      if (i !== -1) this._children.splice(i, 1);
    }
    this._postChildren = [];
    this._teardownGestures();
    this._clearPageGhosts();
  }

  /** Tear down the swipe gesture controllers and the touch-down layer hooks. */
  _teardownGestures() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
    if (this._gestureEl) {
      this._gestureEl.removeEventListener('touchstart', this._onTouchPromote);
      this._gestureEl = null;
    }
    if (this._onKeyNav) {
      window.removeEventListener('keydown', this._onKeyNav);
      this._onKeyNav = null;
    }
    for (const a of this._navArrows || []) a.remove();
    this._navArrows = null;
    this._stride = null;
  }

  _setupGestures(pagination) {
    // Always capture horizontal swipes (even on single-page lists) so they
    // rubber-band instead of triggering browser history back/forward.
    const gridMount = this.$('#grid-mount');
    const vw = () => window.innerWidth || 500;
    const atEnd = () => pagination.page >= pagination.pages;
    const atStart = () => pagination.page <= 1;

    this._gesture = new GestureController(this.$('.site-main'), {
      // Engage the drag a touch sooner than the immersive default so the grid
      // starts tracking the finger promptly instead of feeling laggy.
      commitThresholdPx: 8,
      onSwipeMove: (dx, dy) => {
        if (Math.abs(dx) <= Math.abs(dy)) return;
        const dir = dx < 0 ? 'next' : 'prev';
        const blocked = (dir === 'next' && atEnd()) || (dir === 'prev' && atStart());
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
        gridMount.style.opacity = String(
          ghost ? Math.max(0, 1 - ratio) : Math.max(blocked ? 0.85 : 0.2, 1 - ratio),
        );

        this._clearOtherPeek(dir);
        if (ghost) {
          // One symmetric stride (grid width + the inter-column gap) drives the
          // neighbour in from either edge, so the gap between the outgoing and
          // incoming grids is identical in both directions. (Previously the
          // ghost was viewport-wide while the grid was inset by the container
          // padding, so a "prev" drag landed the ghost flush with no gap.)
          // Use the value cached at touch-down — never measure layout here, or
          // the per-frame offsetWidth read thrashes against the transform write.
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
      onSwipeCommit: (dir) => {
        // Only horizontal swipes paginate; a vertical swipe is a page scroll.
        if (dir !== 'left' && dir !== 'right') return;
        const d = dir === 'left' ? 'next' : 'prev';
        if ((d === 'next' && atEnd()) || (d === 'prev' && atStart())) {
          this._resetGridSwipe();
        } else {
          this._commitPageSwipe(d, pagination);
        }
      },
    });

    this._trackpad = new TrackpadDetector(this.$('.site-main'), {
      onHorizontal: (dir) => {
        if (dir === 'left' && pagination.page < pagination.pages) {
          ViewContext.update({ page: pagination.page + 1 });
        } else if (dir === 'right' && pagination.page > 1) {
          ViewContext.update({ page: pagination.page - 1 });
        }
      },
    });

    // The grid's compositor layer is created ahead of time by _promoteGridAhead
    // (during idle, after render), so the costly one-off rasterization of the
    // image-heavy grid is already done before a finger ever lands. Promoting it
    // lazily — even on touchstart — left the first few drag frames blocked on
    // that raster, so the grid ignored the finger and then snapped to it.
    // Touchstart now only caches the slide stride so onSwipeMove never measures
    // layout mid-drag.
    const siteMain = this.$('.site-main');
    this._onTouchPromote = () => {
      this._stride = this._swipeStride();
    };
    siteMain.addEventListener('touchstart', this._onTouchPromote, { passive: true });
    this._gestureEl = siteMain;

    this._setupPageControls(pagination);
  }

  // Keyboard + mouse page navigation for the grid, complementing swipe/trackpad.
  // Keyboard works in every mode (arrows + hjkl-style); the edge arrows are the
  // mouse path for distraction-free mode, where the paginator is hidden (the DF
  // plugin CSS reveals them on hover for fine pointers only — touch swipes).
  _setupPageControls(pagination) {
    const pages = pagination.pages || 1;
    const goPrev = () => { if (pagination.page > 1) ViewContext.update({ page: pagination.page - 1 }); };
    const goNext = () => { if (pagination.page < pages) ViewContext.update({ page: pagination.page + 1 }); };

    this._onKeyNav = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      // Never hijack keys while the user is typing (search box, etc.).
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // h/k = back, l/j = forward — arrow keys likewise. Up/Down are left to the
      // browser so vertical scrolling still works.
      if (e.key === 'ArrowLeft' || e.key === 'h' || e.key === 'k') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'j') { e.preventDefault(); goNext(); }
    };
    window.addEventListener('keydown', this._onKeyNav);

    const CHEVRON = (d) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    this._navArrows = [['prev', goPrev, 'Previous page', 'M15 18l-6-6 6-6'],
                       ['next', goNext, 'Next page', 'M9 18l6-6-6-6']].map(([dir, go, label, d]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `df-nav-arrow df-nav-${dir}`;
      b.setAttribute('aria-label', label);
      b.innerHTML = CHEVRON(d);
      b.disabled = dir === 'prev' ? pagination.page <= 1 : pagination.page >= pages;
      b.addEventListener('click', go);
      document.body.appendChild(b);
      return b;
    });
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
    const promote = () => this.$('#grid-mount')?.classList.add('grid-promoted');
    if (typeof requestIdleCallback === 'function') requestIdleCallback(promote);
    else requestAnimationFrame(promote);
  }

  // ── Adjacent-page preloading + swipe peek ──────────────────────────────────

  /** The preloaded ghost grid element for a drag direction, if ready. */
  _pageGhost(dir) {
    return this._pageGhosts?.[dir]?.el || null;
  }

  /**
   * The off-screen slide distance for a page swipe: the live grid's width plus
   * the inter-column gap. Driving every neighbour position (rest, drag, reset,
   * commit) from this single value keeps the gap between the outgoing and
   * incoming grids symmetric in both directions and independent of the viewport
   * width vs. the padded container width.
   */
  _swipeStride() {
    const gm = this.$('#grid-mount');
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
  async _preloadAdjacentGrids(pagination) {
    this._pageGhosts = this._pageGhosts || { prev: null, next: null };
    const liveGrid = this.$('#grid-mount');
    const container = liveGrid?.parentElement;
    if (!container || !pagination || pagination.pages <= 1) return;
    // The live grid stretches its cards to fill the viewport when content is
    // short (grid-expand). The ghost sits outside that flex, so pin it to the
    // live grid's height and let its grid stretch to match — otherwise the
    // incoming page's cards render at their shorter natural size.
    const gridHeight = liveGrid.offsetHeight;
    const version = (this._ghostVersion = (this._ghostVersion || 0) + 1);
    const vc = ViewContext.current();

    const build = async (dir) => {
      const page = dir === 'next' ? pagination.page + 1 : pagination.page - 1;
      if (page < 1 || page > pagination.pages) return;
      let data;
      try {
        data = await getHomePage(this._buildParams({ ...vc, page }));
      } catch {
        return;
      }
      if (this._unmounted || version !== this._ghostVersion) return;
      const el = document.createElement('div');
      el.className = 'grid-preview-placeholder';
      el.dataset.edge = dir;
      if (gridHeight) el.style.height = `${gridHeight}px`;
      el.innerHTML = this._buildGridHtml(data.posts || []);
      container.appendChild(el);
      // Warm the neighbour cards' media now, while the ghost is parked
      // off-screen. The cards paint media as CSS background-image, which the
      // browser won't fetch or decode until the element is actually painted —
      // so without this the first drag frame (when the ghost fades in) pays the
      // whole grid's fetch+decode+paint cost at once, which is the start-of-drag
      // hitch. Decoding ahead of time lets that first frame just composite an
      // already-rasterized layer.
      this._warmGridMedia(data.posts || []);
      // Rest off-screen at one full stride so the first drag frame doesn't jump.
      const stride = this._swipeStride();
      el.style.transform = `translateX(${dir === 'next' ? stride : -stride}px)`;
      el.style.opacity = '0';
      this._pageGhosts[dir] = { page, el };
    };
    await Promise.all([build('prev'), build('next')]);
  }

  /**
   * Pre-fetch and pre-decode the neighbour cards' background-image media so the
   * first frame of a swipe composites an already-rasterized ghost instead of
   * triggering a grid-wide fetch+decode+paint burst. Videos paint via <video>
   * (not background-image) and are skipped here. Runs at idle so it never
   * competes with the live grid's own first paint.
   */
  _warmGridMedia(posts) {
    const VIDEO_RE = /\.(?:mp4|webm|mov|ogv|m4v|avi|mkv)$/i;
    const urls = posts
      .map((p) => p && p.media_url)
      .filter((u) => u && !VIDEO_RE.test(u));
    if (!urls.length) return;
    const warm = () => {
      for (const url of urls) {
        if (this._warmedMedia?.has(url)) continue;
        (this._warmedMedia ||= new Set()).add(url);
        const im = new Image();
        im.src = url;
        im.decode?.().catch(() => {});
      }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm);
    else setTimeout(warm, 0);
  }

  /** Build static grid markup (real cards, no listeners) for a ghost preview. */
  _buildGridHtml(posts) {
    if (!posts.length) return '<p class="empty-state">No posts yet.</p>';
    const settings = store.get('settings') || {};
    const heroIndex = posts.findIndex((p) => p.is_featured);
    const dummy = document.createElement('div');
    const slots = posts.map((post, i) => {
      const cls = i === heroIndex ? ' featured-post' : '';
      const card = new PostCard(dummy, {
        post,
        showViewCount: !!settings.show_view_counts,
        useThumbnails: settings.use_thumbnails !== false,
        isHero: i === heroIndex,
      }).render();
      return `<div class="post-card-slot${cls}">${card}</div>`;
    }).join('');
    return `<div class="posts-grid">${slots}</div>`;
  }

  /** Remove the off-screen ghost grids and invalidate any in-flight preload. */
  _clearPageGhosts() {
    this._ghostVersion = (this._ghostVersion || 0) + 1;
    if (this._pageGhosts) {
      for (const dir of ['prev', 'next']) {
        this._pageGhosts[dir]?.el?.remove();
        this._pageGhosts[dir] = null;
      }
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
    const gridMount = this.$('#grid-mount');
    if (gridMount) {
      gridMount.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      gridMount.style.transform = '';
      gridMount.style.opacity = '1';
      gridMount.classList.remove('grid-swiping');
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

  /**
   * Carry a committed swipe to rest: the active grid finishes sliding off while
   * the preloaded neighbour grid slides to centre, then the route swaps under
   * it — the new page's real grid mounts beneath the ghost and the ghost is
   * dropped, so the motion flows unbroken with no reload blink.
   */
  _commitPageSwipe(dir, pagination) {
    const ghost = this._pageGhost(dir);
    const targetPage = dir === 'next' ? pagination.page + 1 : pagination.page - 1;

    // No preloaded grid yet (slow network / just landed): fall back to the
    // plain crossfade by navigating straight away.
    if (!ghost) {
      this._resetGridSwipe();
      ViewContext.update({ page: targetPage });
      return;
    }

    const gridMount = this.$('#grid-mount');
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

    // Hold this ghost on screen across the route swap; _refreshPostContent drops
    // it once the real grid is mounted underneath.
    this._committedGhost = ghost;
    this._pageGhosts[dir] = null;
    this._peekGhost = null;

    setTimeout(() => {
      if (this._unmounted) return;
      this._seamlessSwipe = true;
      ViewContext.update({ page: targetPage });
    }, 280);
  }

  _onTimelineRangeChange({ from, to, isFullExtent }) {
    const years = isFullExtent ? null : [from, to];
    const vc = ViewContext.current();
    const same = years
      ? vc.years && vc.years[0] === years[0] && vc.years[1] === years[1]
      : !vc.years;
    if (same) return;
    ViewContext.update({ years });
  }

  beforeUnmount() {
    this._teardownGestures();
    this._clearPageGhosts();
    this._committedGhost?.remove();
    this._committedGhost = null;
    clearTimeout(this._resizeTimer);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
  }

  mount() {
    // Seed the per_page cache from the window size so the first fetch is sized
    // before the grid exists to be measured.
    if (!ViewContext.current().perPage) computePerPage(this._minPerPage(), null);
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);
    super.mount();
    this._load();
  }

  async _load() {
    const vc = ViewContext.current();
    this._loadedVc = vc;

    try {
      const data = await getHomePage(this._buildParams(vc));
      // Merge settings from page response into store.
      if (data.settings) store.set('settings', { ...store.get('settings'), ...normalizeSettings(data.settings) });
      // tag_cloud is page-independent and only sent on page 1; cache it so it
      // persists across pagination, swipes, and direct loads of later pages.
      if (data.tag_cloud) store.set('tagCloud', data.tag_cloud);

      // Check for hash to set initial slide index (e.g. #2 -> index 1)
      let startIndex = 0;
      let forceImmersive = false;
      const hash = window.location.hash;
      if (hash && hash.startsWith('#')) {
        const num = parseInt(hash.slice(1), 10);
        if (!isNaN(num) && num > 0) {
          startIndex = Math.max(0, num - 1);
          if (num > 1) forceImmersive = true;
        }
      }

      this.setState({ loading: false, data, error: null, startIndex, forceImmersive });
    } catch (err) {
      this.setState({ loading: false, data: null, error: err.message || 'Failed to load posts.' });
    }
  }
}
