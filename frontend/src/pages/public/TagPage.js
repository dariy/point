/**
 * TagPage — posts filtered by a single tag, with breadcrumb navigation.
 *
 * Grid mode (no query.slug):  GET /api/pages/tag/:slug
 * Post mode  (query.slug set): GET /api/pages/tag/:slug  +  GET /api/posts/slug/:slug
 *
 * In post mode the page renders the specific post in immersive layout, with
 * prev/next navigation scoped to this tag's post list.  URLs take the form:
 *   /tag/2018?slug=some-post-slug
 *
 * Props (from router): { params: { slug }, query: { page, slug } }
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { PostGrid } from '../../components/public/PostGrid.js';
import { PostContent, shouldUseImmersive } from '../../components/public/PostContent.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { getTagPage } from '../../api/pages.js';
import { getPostBySlug } from '../../api/posts.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';

export default class TagPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, post: null, error: null };
  }

  _isPostView() {
    return !!this.props.query?.slug;
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading…"></div>
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

    if (this._isPostView()) {
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

    return `
      <div class="site-wrapper tags-page">
        <div id="header-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    const navTags  = this.state.data?.nav_tags || store.get('navTags') || [];
    const slug     = this.props.params?.slug || '';
    const { data, post } = this.state;

    // Build breadcrumb: ancestors are links, current tag is the non-linked tail.
    const tag = data?.tag;
    const breadcrumbs = data?.breadcrumbs || [];
    const lastCrumbIsCurrentTag =
      breadcrumbs.length > 0 && breadcrumbs[breadcrumbs.length - 1]?.slug === tag?.slug;
    const computedBreadcrumb = lastCrumbIsCurrentTag
      ? breadcrumbs.map(bc => ({ name: bc.name, slug: bc.slug }))
      : [
          ...breadcrumbs.map(bc => ({ name: bc.name, slug: bc.slug })),
          ...(tag ? [{ name: tag.name, slug: tag.slug }] : []),
        ];
    const bcCacheKey = `bc:tag:${slug}`;
    if (data) store.set(bcCacheKey, computedBreadcrumb);
    const breadcrumb = computedBreadcrumb.length ? computedBreadcrumb : (store.get(bcCacheKey) || []);

    if (this._isPostView() && post) {
      // ── Post immersive view within tag context ──────────────────────────────
      const posts = data?.posts || [];
      const postIndex = posts.findIndex(p => p.slug === post.slug);
      const prevPost = postIndex > 0 ? posts[postIndex - 1] : null;
      const nextPost = postIndex !== -1 && postIndex < posts.length - 1 ? posts[postIndex + 1] : null;

      const immersive = shouldUseImmersive(post);

      this.mountChild(PublicHeader, '#header-mount', {
        settings,
        navTags: immersive ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb,
        currentPath: '',
      });

      this.mountChild(PublicFooter, '#footer-mount', {
        settings,
        immersiveTags: immersive ? (post.tags || []) : [],
        immersiveNav: immersive ? { prev: prevPost, next: nextPost } : null,
        tagSlug: immersive ? slug : null,
      });

      this.mountChild(PostContent, '#content-mount', {
        post,
        showViewCount: !!settings.show_view_counts,
        prevPost,
        nextPost,
        tagSlug: slug,
      });
    } else {
      // ── Grid view ───────────────────────────────────────────────────────────
      const page = parseInt(this.props.query?.page || '1', 10);

      this.mountChild(PublicHeader, '#header-mount', {
        settings,
        navTags: this._isPostView() ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb,
        currentPath: '',
      });
      this.mountChild(PublicFooter, '#footer-mount', { settings });

      if (this.state.loading || !data) return;

      const { posts = [], pagination = {} } = data;

      this.mountChild(PostGrid, '#grid-mount', {
        posts,
        showViewCount: !!settings.show_view_counts,
        tagSlug: slug,
        tagPage: page,
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
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const { slug } = this.props.params || {};
    const postSlug = this.props.query?.slug;
    const page = parseInt(this.props.query?.page || '1', 10);

    if (!slug) {
      this.setState({ loading: false, error: 'Invalid tag URL.' });
      return;
    }

    try {
      const data = await getTagPage(slug, { page });

      if (postSlug) {
        const post = await getPostBySlug(postSlug);
        document.title = `${post.title} — ${data.tag?.name || slug}`;
        this.setState({ loading: false, data, post, error: null });
      } else {
        document.title = `${data.tag?.name || slug} — Posts`;
        this.setState({ loading: false, data, post: null, error: null });
      }
    } catch (err) {
      const msg = err.status === 404 ? 'Not found.' : (err.message || 'Failed to load.');
      this.setState({ loading: false, data: null, post: null, error: msg });
    }
  }
}
