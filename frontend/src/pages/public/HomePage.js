/**
 * HomePage — public blog index.
 *
 * Fetches: GET /api/pages/home
 * Layout:  header / posts-grid + tag-cloud sidebar / pagination / footer
 *
 * Props (from router): { params, query: { page } }
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { PostGrid } from '../../components/public/PostGrid.js';
import { TagCloud } from '../../components/public/TagCloud.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { getHomePage } from '../../api/pages.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { navigate } from '../../utils/helpers.js';

export default class HomePage extends Component {
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

    const { posts = [], tag_cloud = [] } = data || {};

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div class="posts-layout">
              <section class="posts-main" aria-label="Posts">
                <div id="grid-mount"></div>
                <div id="pagination-mount"></div>
              </section>
              ${tag_cloud.length ? '<aside class="posts-sidebar"><div id="tagcloud-mount"></div></aside>' : ''}
            </div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    this.mountChild(PublicHeader, '#header-mount', { settings, currentPath: '/' });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    if (this.state.loading || !this.state.data) return;

    const { posts = [], pagination = {}, tag_cloud = [] } = this.state.data;
    const showViewCount = !!settings.show_view_counts;

    this.mountChild(PostGrid, '#grid-mount', { posts, showViewCount });

    if (pagination.pages > 1) {
      this.mountChild(Pagination, '#pagination-mount', {
        page: pagination.page,
        pages: pagination.pages,
        total: pagination.total,
        onPage: (p) => navigate(`/?page=${p}`),
      });
    }

    const tagcloudMount = this.$('#tagcloud-mount');
    if (tagcloudMount && tag_cloud.length) {
      this.mountChild(TagCloud, '#tagcloud-mount', { tags: tag_cloud });
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const page = parseInt(this.props.query?.page || '1', 10);
    try {
      const data = await getHomePage({ page });
      // Merge settings from page response into store.
      if (data.settings) store.set('settings', { ...store.get('settings'), ...data.settings });
      this.setState({ loading: false, data, error: null });
    } catch (err) {
      this.setState({ loading: false, data: null, error: err.message || 'Failed to load posts.' });
    }
  }
}
