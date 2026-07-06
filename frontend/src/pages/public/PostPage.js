/**
 * PostPage — single post view.
 *
 * Fetches: GET /api/posts/slug/:slug  +  GET /api/posts/:id/navigation
 * Props (from router): { params: { slug }, query }
 */

import { Component } from '../../components/Component.js';
import { pluginHost } from '../../core/pluginHost.js';
import { PostContent, shouldUseImmersive } from '../../components/public/PostContent.js';
import { getPostBySlug, getPostNavigation } from '../../api/posts.js';
import { store } from '../../store.js';
import { escapeHtml, setCanonical, removeCanonical } from '../../utils/helpers.js';
import { formatDate } from '../../utils/formatters.js';
import { ViewContext } from '../../utils/viewContext.js';
import { enterImmersive, exitImmersive, decodeImmersiveHash } from '../../utils/immersiveNav.js';
import { isSlideshowRunning } from '../../plugins/slideshow/Slideshow.js';

export default class PostPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, post: null, nav: null, error: null, forceImmersive: false, startIndex: 0 };
    this._headerChild = null;
    this._footerChild = null;
    this._contentChild = null;
    this._loadVersion = 0;
  }
  beforeUnmount() {
    clearTimeout(this._spinnerTimer);
    // Leaving the post route (other than via the viewer's close, which has
    // already consumed it) abandons any Atlas-return flow, so drop its marker.
    // Post→post navigation reuses this page via onRouteUpdate and never reaches
    // here, so the marker survives swiping between posts.
    try { sessionStorage.removeItem('atlasOpenContext'); } catch { /* ignore */ }
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
    if (this._skipNonImmersiveDuringShow(post, nav, immersive)) return;

    // Breadcrumb: show post title in header branding area
    let postTooltip = '';
    if (post) {
      const dateStr = formatDate(post.published_at || post.created_at);
      const viewStr = settings.show_view_counts && post.view_count != null
        ? ` · ${post.view_count} views` : '';
      postTooltip = dateStr + viewStr;
    }
    const breadcrumb = post ? [{ name: post.title, is_hidden: post.is_hidden || post.is_hidden_by_tag, tooltip: postTooltip }] : [];

    // In immersive mode suppress the tag filter bar (post tags go in the footer instead),
    // but keep the custom menu visible since it contains explicit navigation links.
    const isCustomMenu = settings.nav_menu_mode === 'custom';
    pluginHost.fill('header', this.$('#header-mount'), {
      settings,
      navTags: (!post || (immersive && !isCustomMenu)) ? [] : navTags,
      breadcrumb,
      currentPath: '',
      editUrl: post ? `/light/posts/${post.id}/edit` : null,
      showShare: !!post,
      onToggleImmersive: post && !immersive ? () => enterImmersive(this, 0) : null,
    }).then(comps => {
      if (comps[0] && !this._unmounted) {
        this._headerChild = comps[0];
        this._children.push(comps[0]);
      }
    });

    // Immersive footer shows post tags + post-to-post navigation; normal footer shows pagination slot
    const immersiveTags = immersive ? (post?.tags || []) : [];
    const immersiveNav = immersive ? { prev: nav?.prev || null, next: nav?.next || null } : null;
    pluginHost.fill('footer', this.$('#footer-mount'), { settings, immersiveTags, immersiveNav }).then(comps => {
      if (comps[0] && !this._unmounted) {
        this._footerChild = comps[0];
        this._children.push(comps[0]);
      }
    });

    if (!post) return;

    this._contentChild = this.mountChild(PostContent, '#content-mount', {
      post,
      showViewCount: !!settings.show_view_counts,
      showImmersiveExcerpt: settings.show_immersive_excerpt !== 'false',
      prevPost: nav?.prev || null,
      nextPost: nav?.next || null,
      forceImmersive: immersive,
      startIndex: this.state.startIndex,
      onExitImmersive: () => exitImmersive(this),
      onEnterImmersive: (idx = 0) => enterImmersive(this, idx),
    });
  }

  /**
   * The slideshow plays immersive posts only. When it crosses into a
   * non-immersive post (which mounts no viewer, so the show would stall), keep
   * moving in the show's forward direction — the same target MediaViewer would
   * cross to (see _targetFor('fwd')): navNext under feed direction, else navPrev.
   * Returns true when it navigated away, so the caller skips rendering this post.
   */
  _skipNonImmersiveDuringShow(post, nav, immersive) {
    if (immersive || !isSlideshowRunning()) return false;
    const settings = store.get('settings') || {};
    const fwd = settings.immersive_nav_direction === 'feed' ? nav?.next : nav?.prev;
    if (!fwd?.slug) return false; // end of the feed — let the show stop here
    ViewContext.update({ postSlug: fwd.slug });
    return true;
  }

  /**
   * Called by the router when navigating to another post (same route pattern).
   * Updates content in-place so header/footer don't blink.
   */
  onRouteUpdate(params, query) {
    // Any URL-driven change (Back/Forward, cross-post swipe) means the
    // history entry pushed by enterImmersive() is no longer ours to unwind.
    this._immersivePushed = false;
    this.props = { ...this.props, params, query };
    // Update state without re-rendering so a stale setState can't show old data.
    this.state = { ...this.state, loading: true, post: null, nav: null, error: null };
    const version = ++this._loadVersion;

    // If #content-mount exists we're in loaded state — update content area in-place.
    const contentEl = this.container.querySelector('#content-mount');
    if (contentEl && this._contentChild) {
      // Keep the current post on screen while the next one loads; only fall
      // back to a spinner if the load is slow. Adjacent posts are preloaded
      // (and cached) by the immersive viewer, so they resolve within a frame
      // and the swap is seamless — no spinner blink at the end of a swipe.
      clearTimeout(this._spinnerTimer);
      this._spinnerTimer = setTimeout(() => {
        if (version !== this._loadVersion || this._unmounted) return;
        this._showContentSpinner();
      }, 180);
      this._load(version, true);
    } else {
      // Still in initial loading state — supersede the old load, fall back to full render.
      this._load(version, false);
    }
  }

  /** Replace the current content with a loading spinner (slow in-place load). */
  _showContentSpinner() {
    const contentEl = this.container.querySelector('#content-mount');
    if (!contentEl) return;
    if (this._contentChild) {
      this._contentChild.unmount();
      this._children = this._children.filter(c => c !== this._contentChild);
      this._contentChild = null;
    }
    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';
    spinner.setAttribute('aria-label', 'Loading post…');
    contentEl.textContent = '';
    contentEl.appendChild(spinner);
  }

  /**
   * Apply a loaded post to header/footer/content without tearing down the page wrapper.
   *
   * Header and footer are updated via setProps() so their containers are never
   * empty — the old markup is replaced atomically by the new markup in a single
   * assignment, avoiding the layout shift that unmount() (which clears the
   * container) would cause.  beforeRender() hooks on those components handle
   * the cleanup (ResizeObserver, EXIF flyout, etc.) before the replacement.
   *
   * Content was explicitly unmounted in onRouteUpdate(), so it is always
   * created fresh here.
   */
  _applyPostUpdate(post, nav, startIndex, forceImmersive) {
    clearTimeout(this._spinnerTimer);
    this.state = { loading: false, post, nav, error: null, startIndex, forceImmersive };

    const settings = store.get('settings') || {};
    const navTags  = store.get('navTags') || [];
    const immersive = forceImmersive || shouldUseImmersive(post);
    if (this._skipNonImmersiveDuringShow(post, nav, immersive)) return;

    const dateStr = formatDate(post.published_at || post.created_at);
    const viewStr = settings.show_view_counts && post.view_count != null
      ? ` · ${post.view_count} views` : '';
    const postTooltip = dateStr + viewStr;
    const breadcrumb = [{ name: post.title, is_hidden: post.is_hidden || post.is_hidden_by_tag, tooltip: postTooltip }];
    const isCustomMenu = settings.nav_menu_mode === 'custom';

    const immersiveTags = immersive ? (post.tags || []) : [];
    const immersiveNav = immersive ? { prev: nav?.prev || null, next: nav?.next || null } : null;

    // setProps() replaces container.innerHTML without clearing the container
    // first, so the header/footer are never briefly empty during the update.
    // beforeRender() on each component disconnects stale observers/listeners.
    this._headerChild?.setProps({
      settings,
      navTags: immersive && !isCustomMenu ? [] : navTags,
      breadcrumb,
      currentPath: '',
      editUrl: `/light/posts/${post.id}/edit`,
      showShare: !!post,
      onToggleImmersive: !immersive ? () => enterImmersive(this, 0) : null,
    });

    this._footerChild?.setProps({ settings, immersiveTags, immersiveNav });

    // The previous post may still be on screen (fast cached load) or already
    // replaced by a spinner (slow load). Either way, tear down the old content
    // child before mounting the new one so its listeners don't leak. unmount()
    // clears #content-mount, so the swap is atomic.
    const contentEl = this.container.querySelector('#content-mount');
    if (this._contentChild) {
      this._contentChild.unmount();
      this._children = this._children.filter(c => c !== this._contentChild);
      this._contentChild = null;
    }
    if (contentEl) {
      this._contentChild = new PostContent(contentEl, {
        post,
        showViewCount: !!settings.show_view_counts,
        showImmersiveExcerpt: settings.show_immersive_excerpt !== 'false',
        prevPost: nav?.prev || null,
        nextPost: nav?.next || null,
        forceImmersive: immersive,
        startIndex,
        onExitImmersive: () => exitImmersive(this),
        onEnterImmersive: (idx = 0) => enterImmersive(this, idx),
      });
      this._contentChild.mount();
      this._children.push(this._contentChild);
    }
  }

  _showContentError(msg) {
    clearTimeout(this._spinnerTimer);
    const contentEl = this.container.querySelector('#content-mount');
    if (contentEl) {
      if (this._contentChild) {
        this._contentChild.unmount();
        this._children = this._children.filter(c => c !== this._contentChild);
        this._contentChild = null;
      }
      const p = document.createElement('p');
      p.className = 'error-message';
      p.setAttribute('role', 'alert');
      p.textContent = msg;
      contentEl.textContent = '';
      contentEl.appendChild(p);
    }
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
    this._load(++this._loadVersion, false);
  }

  async _load(version, isInPlaceUpdate) {
    const { slug } = this.props.params || {};
    if (!slug) {
      if (isInPlaceUpdate) this._showContentError('Invalid post URL.');
      else this.setState({ loading: false, error: 'Invalid post URL.' });
      return;
    }

    try {
      const post = await getPostBySlug(slug);
      if (this._unmounted || version !== this._loadVersion) return;

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
      if (this._unmounted || version !== this._loadVersion) return;

      // The slide hash (#1, #2, …) encodes forced immersive mode + start index.
      const { startIndex, forceImmersive } = decodeImmersiveHash(window.location.hash);

      if (isInPlaceUpdate) {
        this._applyPostUpdate(post, postNav, startIndex, forceImmersive);
      } else {
        this.setState({ loading: false, post, nav: postNav, error: null, startIndex, forceImmersive });
      }
    } catch (err) {
      if (this._unmounted || version !== this._loadVersion) return;
      const msg = err.status === 404 ? 'Post not found.' : (err.message || 'Failed to load post.');
      if (isInPlaceUpdate) this._showContentError(msg);
      else this.setState({ loading: false, post: null, nav: null, error: msg });
    }
  }
}
