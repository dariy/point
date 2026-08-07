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
import { PostContent, shouldUseImmersive } from '../../components/public/PostContent.js';

import { Pagination } from '../../components/shared/Pagination.js';
import { getHomePage } from '../../api/pages.js';
import { pluginHost } from '../../core/pluginHost.js';
import { store } from '../../store.js';
import { escapeHtml, isShortViewport, normalizeSettings } from '../../utils/helpers.js';
import { GridPager } from '../../core/gridPager.js';
import { ViewContext } from '../../utils/viewContext.js';
import { enterImmersive, exitImmersive, decodeImmersiveHash } from '../../utils/immersiveNav.js';
import { computePerPage, cachedPerPage, applyZoomVar, watchChromeFit, createFitLatch } from '../../utils/gridFit.js';

export default class HomePage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, error: null, forceImmersive: false, startIndex: 0 };
    // Stops the viewport fit chasing a per_page whose own chrome moves the
    // target — see createFitLatch.
    this._fitLatch = createFitLatch();
    // Swipe/trackpad/keyboard pagination and pinch zoom for the grid — see
    // core/gridPager.js. Shared with TagPage and SearchPage.
    this._pager = new GridPager({
      gridMount: () => this.$('#grid-mount'),
      gestureRoot: () => this.$('.site-main'),
      fetchPosts: async (page) => {
        const data = await getHomePage(this._buildParams({ ...ViewContext.current(), page }));
        return data.posts || [];
      },
      gotoPage: (p) => ViewContext.update({ page: p }),
      onZoomCommit: () => {
        this._fitLatch.reset(); // a new column count is a new question to fit
        this._reconcilePerPage({ fromResize: true });
      },
      isAlive: () => !this._unmounted,
      emptyHtml: '<p class="empty-state">No posts yet.</p>',
    });
  }

  onRouteUpdate(params, query) {
    // Any URL-driven change invalidates the history entry enterImmersive() pushed.
    this._immersivePushed = false;
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
    const seamless = this._pager.takeSeamless();
    const fromSwipe = seamless || this._pager.isMidSwipe();

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
      // The real grid is mounted and centred directly under the committed ghost;
      // hand off to it — identical pixels, so no blink.
      this._pager.finishHandoff();
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
  _reconcilePerPage({ fromResize = false, settling = false } = {}) {
    if (this._unmounted) return;
    const grid = this.$('.posts-grid');
    if (!grid) return; // static/immersive home has no grid to fill
    applyZoomVar(); // reclamp the zoom column count to the current viewport
    const vc = ViewContext.current();
    // An explicit per_page in the URL is reproduced as-is on load; only an
    // actual resize re-fits it to the new window. A settling pass is the
    // exception that is not a new decision: it re-measures a value THIS mount
    // computed (_fitOwned) now that the chrome around the grid has finished
    // laying out, so a hand-typed ?per_page= is still reproduced untouched.
    if (vc.perPage && !fromResize && !(settling && this._fitOwned)) return;
    const fit = computePerPage(this._minPerPage(), grid);
    const current = this._loadedPerPage || fit;
    const next = this._fitLatch.accept(current, fit);
    if (next === null) return;
    const firstIndex = (vc.page - 1) * current;
    const newPage = Math.floor(firstIndex / next) + 1;
    this._fitOwned = true;
    ViewContext.update({ per_page: next, page: newPage }, { replace: true });
  }

  _onResize() {
    // Reset on the event, not on the debounced re-fit: the chrome observer fires
    // sooner than 200ms, and a settling pass that ran against the old latch
    // would have its decision cleared out from under it — one whole extra
    // flicker cycle before the new viewport settles.
    this._fitLatch.reset();
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this._reconcilePerPage({ fromResize: true }), 200);
  }

  /** (Re)arm the settling re-fit for the chrome around the grid — see watchChromeFit. */
  _watchChrome() {
    this._unwatchChrome?.();
    this._unwatchChrome = watchChromeFit(this.container, () => this._reconcilePerPage({ settling: true }));
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
    // Reset the footer paginator's feed; _mountPostContent republishes it when
    // the grid view has pages, so static/immersive/error views show none.
    store.set('pagination', null);
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

    this._pager.disarm();
    const navTags = store.get('navTags') || [];

    // In immersive mode suppress the tag filter bar (post tags go in the footer instead),
    // but keep the custom menu visible since it contains explicit navigation links.
    const isCustomMenu = settings.nav_menu_mode === 'custom';
    const total = this.state.data?.pagination?.total || this.state.data?.total || 0;

    // Settled before the header is filled, not at the mount site further down:
    // the header reads it to decide whether the year facet still needs a crumb,
    // and answering that with last render's value (or `undefined` on the first)
    // showed the crumb on every fresh load whatever the timeline was doing.
    // The conditions mirror the mount below — a static home page and a page
    // still loading render no timeline at all.
    this._canShowTimeline =
      !isStaticHomePage && !this.state.loading && !!this.state.data
      && pluginHost.hasSlot('timeline');

    pluginHost.fill('header', this.$('#header-mount'), {
      settings,
      currentPath: '/',
      navTags: (immersive && !isCustomMenu) ? [] : navTags,
      editUrl: (isStaticHomePage && post) ? `/light/posts/${post.id}/edit` : null,
      total,
      // The header drops the year crumb only because the timeline is showing
      // the same range more usefully; on a short viewport the timeline is
      // hidden (css/public/timeline.css), so the crumb is the year's only
      // remaining trace and has to come back. Evaluated at render, so a device
      // rotated mid-view keeps the previous answer until the next navigation.
      timelineVisible: this._canShowTimeline && !isShortViewport(),
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
        onExitImmersive: () => exitImmersive(this),
        onEnterImmersive: (idx = 0) => enterImmersive(this, idx),
      });
      return;
    }

    // home-explore slot (tag cloud).
    const tagCloud = this.state.data.tag_cloud || store.get('tagCloud') || [];
    pluginHost.fill('home-explore', this.$('#tag-cloud-mount'), { tags: tagCloud, settings });

    // timeline slot (decided above, before the header was told about it).
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
    this._pager.resetGridStyles();

    this._postChildren.push(
      this.mountChild(PostGrid, '#grid-mount', {
        posts,
        showViewCount: !!settings.show_view_counts,
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

    // Publish the page state for the footer paginator — on desktop and
    // phone-landscape it replaces the in-flow paginator above (CSS swaps them).
    store.set('pagination', pagination.pages > 1
      ? { page: pagination.page, pages: pagination.pages, total: pagination.total }
      : null);

    this._pager.arm(pagination);

    // After the real grid has laid out, fit per_page to the viewport — then keep
    // watching, because the chrome it has to measure around itself arrives later
    // (see _watchChrome).
    requestAnimationFrame(() => this._reconcilePerPage());
    this._watchChrome();
  }

  _clearPostContent() {
    for (const c of this._postChildren || []) {
      c.unmount();
      const i = this._children.indexOf(c);
      if (i !== -1) this._children.splice(i, 1);
    }
    this._postChildren = [];
    this._pager.disarm();
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
    // Non-grid pages (post, search) share the footer — don't leave a stale
    // paginator feed behind.
    store.set('pagination', null);
    this._pager.destroy();
    clearTimeout(this._resizeTimer);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    this._unwatchChrome?.();
    this._unwatchChrome = null;
  }

  mount() {
    // Seed the per_page cache from the window size so the first fetch is sized
    // before the grid exists to be measured.
    applyZoomVar(); // reflect a sticky zoom before the first grid paints
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

      // The slide hash (#1, #2, …) encodes forced immersive mode + start index.
      const { startIndex, forceImmersive } = decodeImmersiveHash(window.location.hash);

      this.setState({ loading: false, data, error: null, startIndex, forceImmersive });
    } catch (err) {
      this.setState({ loading: false, data: null, error: err.message || 'Failed to load posts.' });
    }
  }
}
