/**
 * SearchPage — public search results.
 *
 * Fetches: GET /api/posts?q=term
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
import { ViewContext } from '../../utils/viewContext.js';
import { computePerPage, cachedPerPage } from '../../utils/gridFit.js';

export default class SearchPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, tags: [], error: null };
  }

  onRouteUpdate(params, query) {
    this.props.params = params;
    this.props.query = query;
    this._load();
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
    const settings = store.get('settings') || {};
    const rootMenu = store.get('navTags') || [];
    const q = this.props.query?.q || '';

    let breadcrumb = [{ name: 'search' }];
    if (q) {
      const displayQuery = q.length > 20 ? q.substring(0, 20) + '…' : q;
      if (this.state.data) {
        const total = this.state.data.total;
        breadcrumb.push({
          name: `${displayQuery}`,
          tooltip: `${total} post${total !== 1 ? 's' : ''} found`
        });
      } else {
        breadcrumb.push({ name: displayQuery });
      }
    }

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

    const { posts = [], page, pages, total } = this.state.data;

    this.mountChild(PostGrid, '#grid-mount', {
      posts,
      showViewCount: !!settings.show_view_counts,
      useThumbnails: settings.use_thumbnails !== false,
      emptyMessage: 'No posts matched your search.',
    });

    if (pages > 1) {
      this.mountChild(Pagination, '#pagination-mount', {
        page,
        pages,
        total,
        onPage: (p) => ViewContext.update({ page: p }),
      });
    }

    // After the real grid has laid out, fit per_page to the viewport.
    requestAnimationFrame(() => this._reconcilePerPage());
  }

  _minPerPage() {
    return (store.get('settings') || {}).posts_per_page || 10;
  }

  // Measure the rendered grid and, if the viewport fits a different number of
  // posts than we loaded, persist the new per_page to the URL — recomputing the
  // page so the first post currently shown stays visible on the resized list.
  _reconcilePerPage({ fromResize = false } = {}) {
    if (this._unmounted) return;
    const grid = this.$('.posts-grid');
    if (!grid) return;
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

  _renderTagResults() {
    const mount = this.$('#tag-results-mount');
    if (!mount) return;

    const tagsHtml = this.state.tags.map(t => `
      <a href="/tags/${escapeHtml(t.slug)}" class="search-tag-chip">
        <span class="tag-name">${escapeHtml(t.name)}</span>
        <span class="tag-count">${t.post_count}</span>
      </a>
    `).join('');

    mount.innerHTML = `
      <div class="search-tag-results">
        <h3 class="search-tag-results-title">Tags</h3>
        <div class="search-tag-strip">
          ${tagsHtml}
        </div>
      </div>
    `;
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

  beforeUnmount() {
    clearTimeout(this._resizeTimer);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
  }

  async _load() {
    const vc = ViewContext.current();
    
    let titleQuery = vc.query || '';
    if (vc.tag) titleQuery += ` in ${vc.tag}`;
    
    document.title = titleQuery ? `Search: ${titleQuery} — ${store.get('settings')?.blog_title || 'Blog'}` : 'Search';

    if (!vc.query?.trim()) {
      this.setState({ loading: false, data: { posts: [], total: 0, page: 1, pages: 1 }, tags: [], error: null });
      return;
    }

    try {
      const perPage = vc.perPage || cachedPerPage(this._minPerPage());
      this._loadedPerPage = perPage;
      const params = { q: vc.query, page: vc.page, per_page: perPage, status: 'published' };
      if (vc.tag) params.tag = vc.tag;

      const [data, tagsData] = await Promise.all([
        listPosts(params),
        listTags({ q: vc.query, include_empty: false })
      ]);
      
      this.setState({ loading: false, data, tags: tagsData.tags || [], error: null });
    } catch (err) {
      this.setState({ loading: false, data: null, tags: [], error: err.message || 'Failed to search.' });
    }
  }
}
