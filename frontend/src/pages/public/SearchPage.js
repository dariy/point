/**
 * SearchPage — public search results.
 *
 * Fetches: GET /api/posts?q=term
 *
 * The results grid is a first-class grid view: it pages by swipe, trackpad,
 * arrow keys and hover chevrons, and zooms by pinch or the footer slider, all of
 * which come from the shared GridPager (core/gridPager.js) that the home and tag
 * grids use. A page change refreshes only the grid — the header, breadcrumb and
 * matching-tag chips depend on the query, not the page, so they stay put.
 *
 * Props (from router): { query: { q, page } }
 */
import { pluginHost } from '../../core/pluginHost.js';
import { Component } from '../../components/Component.js';

import { PostGrid } from '../../components/public/PostGrid.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { listPosts } from '../../api/posts.js';
import { listTags } from '../../api/tags.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { GridPager } from '../../core/gridPager.js';
import { ViewContext } from '../../utils/viewContext.js';
import { computePerPage, cachedPerPage, applyZoomVar, watchChromeFit, createFitLatch } from '../../utils/gridFit.js';

export default class SearchPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, tags: [], error: null };
    // Stops the viewport fit chasing a per_page whose own chrome moves the
    // target — see createFitLatch.
    this._fitLatch = createFitLatch();
    // Swipe/trackpad/keyboard pagination and pinch zoom for the results grid —
    // see core/gridPager.js. Shared with HomePage and TagPage.
    this._pager = new GridPager({
      gridMount: () => this.$('#grid-mount'),
      gestureRoot: () => this.$('.site-main'),
      fetchPosts: async (page) => {
        const data = await listPosts(this._buildParams({ ...ViewContext.current(), page }));
        return data.posts || [];
      },
      gotoPage: (p) => ViewContext.update({ page: p }),
      onZoomCommit: () => {
        this._fitLatch.reset(); // a new column count is a new question to fit
        this._reconcilePerPage({ fromResize: true });
      },
      isAlive: () => !this._unmounted,
      emptyHtml: '<p class="empty-state">No posts matched your search.</p>',
    });
  }

  onRouteUpdate(params, query) {
    const prevVc = this._loadedVc;
    this.props.params = params;
    this.props.query = query;
    const nextVc = ViewContext.current();
    // A page change within the same search only affects the grid — refresh it in
    // place so a committed swipe hands off to the new page without the whole
    // view (header, tag chips) being torn down and rebuilt underneath it.
    if (this._canPartialUpdate(prevVc, nextVc)) {
      this._refreshPostContent();
    } else {
      this._load();
    }
  }

  _canPartialUpdate(prev, next) {
    if (!prev || !this.state.data || this.state.error) return false;
    return prev.query === next.query && prev.tag === next.tag;
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Searching…"></div>
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

    return `
      <div class="site-wrapper search-page">
        <div id="header-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="tag-results-mount"></div>
            <div id="grid-mount" class="grid-expand-mount">
            </div>
            <div id="pagination-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    document.body.classList.remove('immersive-layout', 'ui-hidden', 'immersive-overlay-sheet');
    // Reset the footer paginator's feed; _mountPostContent republishes it when
    // the results run to more than one page.
    store.set('pagination', null);
    this._pager.disarm();
    const settings = store.get('settings') || {};
    const rootMenu = store.get('navTags') || [];
    const q = this.props.query?.q || '';

    // Only the "search" crumb — the query itself is rendered by Breadcrumbs as a
    // facet crumb (“…”) off the ViewContext, so pushing it here duplicated it.
    const resultCount = this.state.data?.total;
    const breadcrumb = [{
      name: 'search',
      ...(q && resultCount !== undefined
        ? { tooltip: `${resultCount} post${resultCount !== 1 ? 's' : ''} found` }
        : {}),
    }];

    pluginHost.fill('header', this.$('#header-mount'), {
      settings,
      navTags: rootMenu,
      currentPath: '/search',
      breadcrumb,
      total: this.state.data?.total || 0,
      timelineVisible: false,
    }).then(comps => {
      if (comps[0] && !this._unmounted) {
        this._children.push(comps[0]);
      }
    });
    pluginHost.fill('footer', this.$('#footer-mount'), { settings }).then(comps => {
      if (comps[0] && !this._unmounted) {
        this._children.push(comps[0]);
      }
    });

    if (this.state.tags.length > 0) {
      this._renderTagResults();
    }

    if (this.state.loading || !this.state.data) return;

    this._mountPostContent();
  }

  // Mounts the page-dependent content (results grid, pagination, gestures).
  // Kept separate from the page chrome so a page change can refresh just this in
  // place — see _refreshPostContent.
  _mountPostContent() {
    const settings = store.get('settings') || {};
    const { posts = [], page, pages, total } = this.state.data;

    this._postChildren = [];

    // A paginated swipe leaves an inline transform on the grid mount; clear it so
    // the refreshed grid isn't left offset.
    this._pager.resetGridStyles();

    this._postChildren.push(
      this.mountChild(PostGrid, '#grid-mount', {
        posts,
        showViewCount: !!settings.show_view_counts,
        emptyMessage: 'No posts matched your search.',
      }),
    );

    this._syncPagination({ page, pages, total });
    this._pager.arm({ page, pages, total });

    // After the real grid has laid out, fit per_page to the viewport — then keep
    // watching, because the chrome it has to measure around itself arrives later
    // (see _watchChrome).
    requestAnimationFrame(() => this._reconcilePerPage());
    this._watchChrome();
  }

  /**
   * Mount, update or drop the in-flow paginator, and publish the same state for
   * the footer paginator (on desktop and phone-landscape CSS shows that one
   * instead). Kept apart from _mountPostContent so a refit can re-point it
   * without the grid beside it being rebuilt.
   */
  _syncPagination({ page, pages, total }) {
    const existing = this._postChildren[1];
    if (pages > 1) {
      const props = { page, pages, total, onPage: (p) => ViewContext.update({ page: p }) };
      if (existing) existing.setProps(props);
      else this._postChildren[1] = this.mountChild(Pagination, '#pagination-mount', props);
    } else if (existing) {
      existing.unmount();
      const at = this._children.indexOf(existing);
      if (at !== -1) this._children.splice(at, 1);
      this._postChildren.length = 1;
    }

    store.set('pagination', pages > 1 ? { page, pages, total } : null);
  }

  /**
   * Apply a per_page refit without remounting anything: hand the grid its new
   * tail, re-point the paginator, re-arm the pager on the new page count.
   *
   * @returns {boolean} false when the grid could not take the new list in place
   *   (the lists diverge), leaving the caller to fall back to a remount.
   */
  _applyRefit() {
    const grid = this._postChildren?.[0];
    const { posts = [], page, pages, total } = this.state.data || {};
    if (!grid?.reconcile?.(posts)) return false;
    this._syncPagination({ page, pages, total });
    this._pager.arm({ page, pages, total });
    this._watchChrome();
    return true;
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

  /**
   * Load another page of the same search and swap just the grid. A swipe that
   * committed has already slid the preloaded neighbour grid to centre (the
   * "committed ghost"), so we hand off to the real grid under it with no fade;
   * otherwise crossfade — fade the current grid out while the next page loads,
   * then fade the fresh grid in.
   */
  async _refreshPostContent() {
    const vc = ViewContext.current();
    const gridMount = this.$('#grid-mount');

    // A refit is a resize of the current view, not a move to another one: the
    // posts already on screen stay exactly where they are and only the tail of
    // the list changes. Crossfading it blanked the grid and read as a page
    // turn — it updates in place instead (_applyRefit).
    const refit = this._refitRefresh;
    this._refitRefresh = false;

    const seamless = this._pager.takeSeamless();
    const fromSwipe = seamless || this._pager.isMidSwipe();

    let fadeOut = Promise.resolve();
    if (gridMount && !fromSwipe && !refit) {
      gridMount.style.transition = 'opacity 0.2s ease-in';
      gridMount.style.opacity = '0';
      fadeOut = new Promise((resolve) => setTimeout(resolve, 200));
    }

    let data;
    try {
      data = await listPosts(this._buildParams(vc));
    } catch (err) {
      this.setState({ loading: false, data: null, tags: [], error: err.message || 'Failed to search.' });
      return;
    }
    if (this._unmounted) return;
    await fadeOut;
    if (this._unmounted) return;

    this.state.data = data;
    this.state.error = null;
    this._loadedVc = vc;
    // A refit keeps every card that is already up — it stops here rather than
    // rebuilding the grid to add or drop the tail of the list.
    if (refit && this._applyRefit()) return;
    this._clearPostContent();
    this._mountPostContent();

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
    const params = { q: vc.query, page: vc.page, per_page: perPage, status: 'published' };
    if (vc.tag) params.tag = vc.tag;
    return params;
  }

  // Measure the rendered grid and, if the viewport fits a different number of
  // posts than we loaded, persist the new per_page to the URL — recomputing the
  // page so the first post currently shown stays visible on the resized list.
  _reconcilePerPage({ fromResize = false, settling = false } = {}) {
    if (this._unmounted) return;
    const grid = this.$('.posts-grid');
    if (!grid) return;
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
    // Tells the refresh this update provokes that it is a refit, not a
    // navigation — see _refreshPostContent.
    this._refitRefresh = true;
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

  _renderTagResults() {
    const mount = this.$('#tag-results-mount');
    if (!mount) return;

    const tagsHtml = this.state.tags.map(t => `
      <a href="/tags/${escapeHtml(t.slug)}" class="search-tag-chip">
        <span class="search-tag-chip-name">${escapeHtml(t.name)}</span>
        <span class="search-tag-chip-count">${t.post_count}</span>
      </a>
    `).join('');
// <h3 class="search-tag-results-title">Tags</h3>
    mount.innerHTML = `
      <div class="search-tag-results">

        <div class="search-tag-strip">
          ${tagsHtml}
        </div>
      </div>
    `;
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

  beforeUnmount() {
    // Non-grid pages share the footer — don't leave a stale paginator feed behind.
    store.set('pagination', null);
    this._pager.destroy();
    clearTimeout(this._resizeTimer);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    this._unwatchChrome?.();
    this._unwatchChrome = null;
  }

  async _load() {
    const vc = ViewContext.current();
    this._loadedVc = vc;
    // A full render rebuilds the grid anyway; don't leave the flag set for
    // whatever refresh comes next.
    this._refitRefresh = false;

    let titleQuery = vc.query || '';
    if (vc.tag) titleQuery += ` in ${vc.tag}`;

    document.title = titleQuery ? `Search: ${titleQuery} — ${store.get('settings')?.blog_title || 'Blog'}` : 'Search';

    if (!vc.query?.trim()) {
      this.setState({ loading: false, data: { posts: [], total: 0, page: 1, pages: 1 }, tags: [], error: null });
      return;
    }

    try {
      const [data, tagsData] = await Promise.all([
        listPosts(this._buildParams(vc)),
        listTags({ q: vc.query, include_empty: false })
      ]);

      this.setState({ loading: false, data, tags: tagsData.tags || [], error: null });
    } catch (err) {
      this.setState({ loading: false, data: null, tags: [], error: err.message || 'Failed to search.' });
    }
  }
}
