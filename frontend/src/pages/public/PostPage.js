/**
 * PostPage — single post view.
 *
 * Fetches: GET /api/posts/slug/:slug  +  GET /api/posts/:id/navigation
 * Props (from router): { params: { slug }, query }
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { PostContent, shouldUseImmersive } from '../../components/public/PostContent.js';
import { getPostBySlug, getPostNavigation } from '../../api/posts.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';

export default class PostPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, post: null, nav: null, error: null };
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading post…"></div>
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
        <main class="site-main">
          <div class="main-container">
            <div id="content-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    const navTags  = store.get('navTags') || [];
    const { post, nav } = this.state;

    const immersive = shouldUseImmersive(post);

    // Breadcrumb: show post title in header branding area
    const breadcrumb = post ? [{ name: post.title }] : [];

    // In immersive mode suppress the tag filter bar; tags go in the footer instead
    this.mountChild(PublicHeader, '#header-mount', {
      settings,
      navTags: immersive ? [] : navTags,
      breadcrumb,
      currentPath: '',
    });

    // Immersive footer shows post tags + post-to-post navigation; normal footer shows pagination slot
    const immersiveTags = immersive ? (post.tags || []) : [];
    const immersiveNav = immersive ? { prev: nav?.prev || null, next: nav?.next || null } : null;
    this.mountChild(PublicFooter, '#footer-mount', { settings, immersiveTags, immersiveNav });

    if (!post) return;

    this.mountChild(PostContent, '#content-mount', {
      post,
      showViewCount: !!settings.show_view_counts,
      prevPost: nav?.prev || null,
      nextPost: nav?.next || null,
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const { slug } = this.props.params || {};
    if (!slug) {
      this.setState({ loading: false, error: 'Invalid post URL.' });
      return;
    }

    try {
      const post = await getPostBySlug(slug);

      document.title = post.title;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.setAttribute('content', post.meta_description || post.excerpt || '');

      let postNav = null;
      try { postNav = await getPostNavigation(post.id); } catch { /* optional */ }

      this.setState({ loading: false, post, nav: postNav, error: null });
    } catch (err) {
      const msg = err.status === 404 ? 'Post not found.' : (err.message || 'Failed to load post.');
      this.setState({ loading: false, post: null, nav: null, error: msg });
    }
  }
}
