/**
 * PreviewPage — draft post preview via shareable token.
 *
 * Fetches: GET /preview/:token  (no auth required)
 * Props (from router): { params: { token }, query }
 *
 * Renders the post in preview mode with a notice banner.
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { PostContent } from '../../components/public/PostContent.js';
import { api } from '../../api/client.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';

export default class PreviewPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, post: null, error: null };
  }

  render() {
    const { loading, post, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading preview…"></div>
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
      <div class="site-wrapper">
        <div id="header-mount"></div>
        <div class="preview-banner" role="status">
          Preview mode — this post is not published
        </div>
        <main class="site-main">
          <div class="main-container content-narrow">
            <div id="content-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    this.mountChild(PublicHeader, '#header-mount', { settings, currentPath: '' });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    if (this.state.post) {
      this.mountChild(PostContent, '#content-mount', {
        post: this.state.post,
        showViewCount: false,
        prevPost: null,
        nextPost: null,
      });
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const { token } = this.props.params || {};
    if (!token) {
      this.setState({ loading: false, error: 'Invalid preview link.' });
      return;
    }
    try {
      const post = await api.get(`/preview/${encodeURIComponent(token)}`);
      document.title = `Preview: ${post.title}`;
      this.setState({ loading: false, post, error: null });
    } catch (err) {
      const msg =
        err.status === 404 ? 'Preview link not found.' :
        err.status === 410 ? 'This preview link has expired.' :
        (err.message || 'Failed to load preview.');
      this.setState({ loading: false, post: null, error: msg });
    }
  }
}
