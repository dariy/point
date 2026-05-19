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
import { escapeHtml, setCanonical, removeCanonical } from '../../utils/helpers.js';
import { formatDate } from '../../utils/formatters.js';

export default class PostPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, post: null, nav: null, error: null, forceImmersive: false, startIndex: 0 };
  }

  beforeUnmount() {
    super.beforeUnmount();
    document.querySelectorAll('meta[property^="og:"]').forEach(el => el.remove());
    document.getElementById('json-ld-blogposting')?.remove();
    removeCanonical();
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

    const immersive = this.state.forceImmersive || shouldUseImmersive(post);

    // Breadcrumb: show post title in header branding area
    let postTooltip = '';
    if (post) {
      const dateStr = formatDate(post.published_at || post.created_at);
      const viewStr = settings.show_view_counts && post.view_count != null
        ? ` · ${post.view_count} views` : '';
      postTooltip = dateStr + viewStr;
    }
    const breadcrumb = post ? [{ name: post.title, is_hidden: post.is_hidden || post.is_hidden_by_tag, tooltip: postTooltip }] : [];

    // In immersive mode suppress the tag filter bar; tags go in the footer instead
    this.mountChild(PublicHeader, '#header-mount', {
      settings,
      navTags: (!post || immersive) ? [] : navTags,
      breadcrumb,
      currentPath: '',
      editUrl: post ? `/light/posts/${post.id}/edit` : null,
    });

    // Immersive footer shows post tags + post-to-post navigation; normal footer shows pagination slot
    const immersiveTags = immersive ? (post.tags || []) : [];
    const immersiveNav = immersive ? { prev: nav?.prev || null, next: nav?.next || null } : null;
    const exifMedia = immersive ? (post.media || []) : [];
    this.mountChild(PublicFooter, '#footer-mount', { settings, immersiveTags, immersiveNav, exifMedia });

    if (!post) return;

    this.mountChild(PostContent, '#content-mount', {
      post,
      showViewCount: !!settings.show_view_counts,
      showImmersiveExcerpt: settings.show_immersive_excerpt !== 'false',
      prevPost: nav?.prev || null,
      nextPost: nav?.next || null,
      forceImmersive: immersive,
      startIndex: this.state.startIndex,
      onEnterImmersive: (idx = 0) => {
        const hash = idx === 0 ? "" : `#${idx + 1}`;
        window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
        this.setState({ forceImmersive: true, startIndex: idx });
      },
    });
  }

  _injectJsonLd(post, descText, ogImageObj) {
    document.getElementById('json-ld-blogposting')?.remove();

    const settings = store.get('settings') || {};
    const canonicalUrl = `${window.location.origin}/posts/${post.slug}`;
    const datePublished = post.published_at || post.created_at;

    const ld = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      url: canonicalUrl,
      datePublished,
    };

    if (post.updated_at && post.updated_at !== datePublished) ld.dateModified = post.updated_at;
    if (descText) ld.description = descText;
    if (settings.author_name) ld.author = { '@type': 'Person', name: settings.author_name };
    if (settings.blog_title) ld.publisher = { '@type': 'Organization', name: settings.blog_title };

    if (ogImageObj) {
      try {
        ld.image = new URL(ogImageObj, window.location.origin).href;
      } catch { /* ignore */ }
    }

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'json-ld-blogposting';
    script.textContent = JSON.stringify(ld);
    document.head.appendChild(script);
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
      setCanonical(`${window.location.origin}/posts/${post.slug}`);
      const metaDesc = document.querySelector('meta[name="description"]');
      const descText = post.meta_description || post.excerpt || '';
      if (metaDesc) metaDesc.setAttribute('content', descText);

      const updateMeta = (prop, content) => {
        if (!content) return;
        let el = document.querySelector(`meta[property="${prop}"]`);
        if (!el) {
          el = document.createElement('meta');
          el.setAttribute('property', prop);
          document.head.appendChild(el);
        }
        el.setAttribute('content', content);
      };

      updateMeta('og:type', 'article');
      updateMeta('og:url', window.location.href);
      updateMeta('og:title', post.title);
      updateMeta('og:description', descText);

      let ogImageObj = null;
      if (post.media && post.media.length > 0 && (post.media[0].path || post.media[0].url)) {
        ogImageObj = post.media[0].path || post.media[0].url;
      } else if (post.content_html) {
        const match = post.content_html.match(/<img[^>]*\ssrc=["']([^"']+)["']/i);
        if (match && match[1]) ogImageObj = match[1];
      }

      if (ogImageObj) {
        try {
          updateMeta('og:image', new URL(ogImageObj, window.location.origin).href);
        } catch (_) { /* ignore invalid URL */ }
      }

      this._injectJsonLd(post, descText, ogImageObj);

      let postNav = null;
      try { postNav = await getPostNavigation(post.id); } catch { /* optional */ }

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

      this.setState({ loading: false, post, nav: postNav, error: null, startIndex, forceImmersive });
    } catch (err) {
      const msg = err.status === 404 ? 'Post not found.' : (err.message || 'Failed to load post.');
      this.setState({ loading: false, post: null, nav: null, error: msg });
    }
  }
}
