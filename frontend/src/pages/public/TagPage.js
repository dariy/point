/**
 * TagPage — posts filtered by a single tag, with breadcrumb navigation.
 *
 * Fetches: GET /api/pages/tag/:slug
 * Props (from router): { params: { slug }, query: { page } }
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { PostGrid } from '../../components/public/PostGrid.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { getTagPage } from '../../api/pages.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';

export default class TagPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, error: null };
  }

  render() {
    const { loading, data, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading tag…"></div>
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

    const { tag = {}, breadcrumbs = [] } = data || {};

    const crumbs = breadcrumbs.map((bc, i) => {
      const isLast = i === breadcrumbs.length - 1;
      if (isLast) {
        return `<span class="breadcrumb-current" aria-current="page">${escapeHtml(bc.name)}</span>`;
      }
      return `<a href="/tag/${escapeHtml(bc.slug)}" class="breadcrumb-link">${escapeHtml(bc.name)}</a>
              <span class="breadcrumb-separator" aria-hidden="true">/</span>`;
    }).join('');

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        <main class="site-main">
          <div class="main-container">
            ${crumbs ? `<nav class="site-breadcrumb" aria-label="Breadcrumb">${crumbs}</nav>` : ''}
            <header class="tag-header">
              <h1 class="tag-name">${escapeHtml(tag.name || '')}</h1>
              ${tag.description ? `<p class="tag-description">${escapeHtml(tag.description)}</p>` : ''}
              <p class="tag-count">${escapeHtml(String(tag.post_count || 0))} posts</p>
            </header>
            <div id="grid-mount"></div>
            <div id="pagination-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    this.mountChild(PublicHeader, '#header-mount', { settings, currentPath: '' });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    if (this.state.loading || !this.state.data) return;

    const { posts = [], pagination = {} } = this.state.data;
    const slug = this.props.params?.slug || '';

    this.mountChild(PostGrid, '#grid-mount', {
      posts,
      showViewCount: !!settings.show_view_counts,
      emptyMessage: 'No posts in this tag yet.',
    });

    if (pagination.pages > 1) {
      this.mountChild(Pagination, '#pagination-mount', {
        page: pagination.page,
        pages: pagination.pages,
        total: pagination.total,
        onPage: (p) => navigate(`/tag/${slug}?page=${p}`),
      });
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const { slug } = this.props.params || {};
    const page = parseInt(this.props.query?.page || '1', 10);
    if (!slug) {
      this.setState({ loading: false, error: 'Invalid tag URL.' });
      return;
    }
    try {
      const data = await getTagPage(slug, { page });
      document.title = `${data.tag?.name || slug} — Posts`;
      this.setState({ loading: false, data, error: null });
    } catch (err) {
      const msg = err.status === 404 ? 'Tag not found.' : (err.message || 'Failed to load tag.');
      this.setState({ loading: false, data: null, error: msg });
    }
  }
}
