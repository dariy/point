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
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';

export default class SearchPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, error: null };
  }

  render() {
    const { loading, error, data } = this.state;
    const q = this.props.query?.q || '';

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
            <header class="page-header">
              <h1 class="page-title">Search Results for "${escapeHtml(q)}"</h1>
              <p class="page-subtitle">${data.total} post${data.total !== 1 ? 's' : ''} found</p>
            </header>
            <div id="grid-mount" class="grid-expand-mount"></div>
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

    this.mountChild(PublicHeader, '#header-mount', {
      settings,
      navTags: rootMenu,
      currentPath: '/search',
    });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

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
        onPage: (p) => navigate(`/search?q=${encodeURIComponent(this.props.query.q || '')}&page=${p}`),
      });
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const q = this.props.query?.q || '';
    const page = parseInt(this.props.query?.page || '1', 10);
    
    document.title = q ? `Search: ${q} — ${store.get('settings')?.blog_title || 'Blog'}` : 'Search';

    if (!q.trim()) {
      this.setState({ loading: false, data: { posts: [], total: 0, page: 1, pages: 1 }, error: null });
      return;
    }

    try {
      const data = await listPosts({ q, page, status: 'published' });
      this.setState({ loading: false, data, error: null });
    } catch (err) {
      this.setState({ loading: false, data: null, error: err.message || 'Failed to search.' });
    }
  }
}
