/**
 * SearchPage — public search results.
 *
 * Fetches: GET /api/posts?q=term
 *
 * Props (from router): { query: { q, page } }
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { PostGrid } from '../../components/public/PostGrid.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { listPosts } from '../../api/posts.js';
import { listTags } from '../../api/tags.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { ViewContext } from '../../utils/viewContext.js';

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
    document.body.classList.remove('immersive-layout', 'ui-hidden');
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

    this.mountChild(PublicHeader, '#header-mount', {
      settings,
      navTags: rootMenu,
      currentPath: '/search',
      breadcrumb,
      total: this.state.data?.total || 0,
      timelineVisible: false,
    });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

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
    super.mount();
    this._load();
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
      const params = { q: vc.query, page: vc.page, status: 'published' };
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
