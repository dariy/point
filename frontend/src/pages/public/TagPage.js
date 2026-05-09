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
import { Timeline } from '../../components/public/Timeline.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { getTagPage } from '../../api/pages.js';
import { getPostBySlug } from '../../api/posts.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, setCanonical, removeCanonical } from '../../utils/helpers.js';
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';

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
        <div id="timeline-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount" class="grid-expand-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }  afterRender() {
    document.body.classList.remove('immersive-layout', 'ui-hidden');
    this._gesture?.destroy();
    this._trackpad?.destroy();
    const settings = store.get('settings') || {};
    const rootMenu = store.get('navTags') || [];
    const navChildren = this.state.data?.nav_children || [];
    const navTags = navChildren.length ? navChildren : rootMenu;
    const slug     = this.props.params?.slug || '';
    const { data, post } = this.state;

    const canShowTimeline = settings.timeline_mode === 'all' || (store.get('user') && settings.timeline_mode === 'hidden');
    if (canShowTimeline && !this._isPostView() && !this.state.loading && !this.state.error) {
      const timelineRange = this._parseTimelineParam(this.props.query?.timeline);
      this.mountChild(Timeline, '#timeline-mount', {
        mode: 'filter',
        initialRange: timelineRange || undefined,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
      });
    }

    // Build breadcrumb: ancestors are links, current tag is the non-linked tail.
    const tag = data?.tag;
    const breadcrumbs = data?.breadcrumbs || [];
    const lastCrumbIsCurrentTag =
      breadcrumbs.length > 0 && breadcrumbs[breadcrumbs.length - 1]?.slug === tag?.slug;
    const computedBreadcrumb = lastCrumbIsCurrentTag
      ? breadcrumbs.map(bc => ({ name: bc.name, slug: bc.slug, is_hidden: bc.is_hidden }))
      : [
          ...breadcrumbs.map(bc => ({ name: bc.name, slug: bc.slug, is_hidden: bc.is_hidden })),
          ...(tag ? [{ name: tag.name, slug: tag.slug, is_hidden: tag.is_hidden }] : []),
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
      const headerBreadcrumb = post
        ? [...breadcrumb, { name: post.title, slug: null }]
        : breadcrumb;

      this.mountChild(PublicHeader, '#header-mount', {
        settings,
        navTags: immersive ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb: headerBreadcrumb,
        currentPath: '',
        editUrl: post ? `/light/posts/${post.id}/edit` : null,
      });

      this.mountChild(PublicFooter, '#footer-mount', {
        settings,
        immersiveTags: immersive ? (post.tags || []) : [],
        immersiveNav: immersive ? { prev: prevPost, next: nextPost } : null,
        tagSlug: immersive ? slug : null,
        exifMedia: immersive ? (post.media || []) : [],
      });

      this.mountChild(PostContent, '#content-mount', {
        post,
        showViewCount: !!settings.show_view_counts,
        showImmersiveExcerpt: settings.show_immersive_excerpt !== 'false',
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
        editUrl: tag ? `/light/tags/${tag.slug}` : null,
      });
      this.mountChild(PublicFooter, '#footer-mount', { settings });

      if (this.state.loading || !data) return;

      const { posts = [], pagination = {} } = data;

      this.mountChild(PostGrid, '#grid-mount', {
        posts,
        showViewCount: !!settings.show_view_counts,
        useThumbnails: settings.use_thumbnails !== false,
        tagSlug: slug,
        tagPage: page,
        emptyMessage: 'No posts in this tag yet.',
      });

      if (pagination.pages > 1) {
        this.mountChild(Pagination, '#pagination-mount', {
          page: pagination.page,
          pages: pagination.pages,
          total: pagination.total,
          onPage: (p) => {
            const params = new URLSearchParams({ page: p });
            const t = new URLSearchParams(location.search).get('timeline');
            if (t) params.set('timeline', t);
            navigate(`/tag/${slug}?${params.toString()}`);
          },
        });
      }

      // Always set up gestures so horizontal swipes are captured and rubber-banded
      // even on single-page lists (prevents browser history back/forward).
      {
        const gridMount = this.$('#grid-mount');
        let previewEl = null;        this._gesture = new GestureController(this.$('.site-main'), {
          onSwipeMove: (dx, dy) => {
            if (Math.abs(dx) > Math.abs(dy)) {
              const blocked = (dx < 0 && pagination.page >= pagination.pages)
                         || (dx > 0 && pagination.page <= 1);
              const tx = blocked ? rubberBand(dx) : dx;
              gridMount.style.transform = `translateX(${tx}px)`;
              gridMount.style.transition = 'none';
              gridMount.style.opacity = blocked
                ? Math.max(0.85, 1 - Math.abs(tx) / (window.innerWidth || 500))
                : Math.max(0.2, 1 - Math.abs(tx) / (window.innerWidth || 500));

              if (blocked) return;

              if (!previewEl) {
                previewEl = document.createElement('div');
                previewEl.className = 'grid-preview-placeholder';
                previewEl.innerHTML = `
                  <div class="posts-grid placeholder-grid" style="opacity: 0.5;">
                    <div class="post-card-slot"></div>
                    <div class="post-card-slot"></div>
                    <div class="post-card-slot"></div>
                    <div class="post-card-slot"></div>
                  </div>
                `;
                gridMount.parentElement.appendChild(previewEl);
                
                const targetPage = dx < 0 ? pagination.page + 1 : pagination.page - 1;
                getTagPage(slug, { page: targetPage }).then((data) => {
                  if (previewEl && data.posts) {
                    const html = data.posts.map((p, i) => {
                      const img = p.media?.find(m => m.type === 'image')?.url;
                      const bg = img ? `url(${img}) center/cover` : 'var(--surface-card)';
                      const cls = i === data.posts.findIndex(x => x.is_featured) ? ' featured-post' : '';
                      return `<div class="post-card-slot${cls}"><div class="post-card" style="background: ${bg}; opacity: 0.8;"></div></div>`;
                    }).join('');
                    previewEl.innerHTML = `<div class="posts-grid">${html}</div>`;
                  }
                }).catch(() => {});
              }

              const offset = dx < 0 ? '100%' : '-100%';
              previewEl.style.transform = `translateX(calc(${offset} + ${dx}px))`;
            }
          },
          onSwipeCancel: () => {
            if (gridMount) {
              gridMount.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
              gridMount.style.transform = '';
              gridMount.style.opacity = '1';
            }
            if (previewEl) {
              previewEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
              previewEl.style.opacity = '0';
              setTimeout(() => {
                previewEl?.remove();
                previewEl = null;
              }, 300);
            }
          },
          onSwipeCommit: (dir) => {
            const t = new URLSearchParams(location.search).get('timeline');
            const buildUrl = (p) => {
              const params = new URLSearchParams({ page: p });
              if (t) params.set('timeline', t);
              return `/tag/${slug}?${params.toString()}`;
            };
            if (dir === 'left' && pagination.page < pagination.pages) {
              navigate(buildUrl(pagination.page + 1));
            } else if (dir === 'right' && pagination.page > 1) {
              navigate(buildUrl(pagination.page - 1));
            } else {
              // Reset visuals if not committed
              if (gridMount) {
                gridMount.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
                gridMount.style.transform = '';
                gridMount.style.opacity = '1';
              }
              if (previewEl) {
                previewEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
                previewEl.style.opacity = '0';
                setTimeout(() => {
                  previewEl?.remove();
                  previewEl = null;
                }, 300);
              }
            }
          }
        });
        this._trackpad = new TrackpadDetector(this.$('.site-main'), {
          onHorizontal: (dir) => {
            const t = new URLSearchParams(location.search).get('timeline');
            const buildUrl = (p) => {
              const params = new URLSearchParams({ page: p });
              if (t) params.set('timeline', t);
              return `/tag/${slug}?${params.toString()}`;
            };
            if (dir === 'left' && pagination.page < pagination.pages) {
              navigate(buildUrl(pagination.page + 1));
            } else if (dir === 'right' && pagination.page > 1) {
              navigate(buildUrl(pagination.page - 1));
            }
          }
        });
      }
    }
  }  beforeUnmount() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
    removeCanonical();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _onTimelineRangeChange({ from, to }) {
    if (!this.state.data) return;
    const settings = store.get('settings') || {};
    const slug = this.props.params?.slug || '';

    const timelineParam = from === to ? `${from}` : `${from}-${to}`;
    const url = new URL(location.href);
    url.searchParams.set('timeline', timelineParam);
    url.searchParams.delete('page');
    history.replaceState(null, '', url.pathname + url.search);

    try {
      const data = await getTagPage(slug, { page: 1, year_from: from, year_to: to });
      this.state.data = data;
      const { posts = [], pagination = {} } = data;
      this.mountChild(PostGrid, '#grid-mount', {
        posts,
        showViewCount: !!settings.show_view_counts,
        useThumbnails: settings.use_thumbnails !== false,
        tagSlug: slug,
        emptyMessage: 'No posts in this tag yet.',
      });
      this.mountChild(Pagination, '#pagination-mount', {
        page: 1,
        pages: pagination.pages || 1,
        total: pagination.total || 0,
        onPage: (p) => {
          const params = new URLSearchParams({ page: p, timeline: timelineParam });
          navigate(`/tag/${slug}?${params.toString()}`);
        },
      });
    } catch (err) {
      console.error('Failed to filter posts by year:', err);
    }
  }

  _parseTimelineParam(param) {
    if (!param) return null;
    const parts = param.split('-').map(Number);
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) return { from: parts[0], to: parts[1] };
    if (parts.length === 1 && parts[0] > 0) return { from: parts[0], to: parts[0] };
    return null;
  }

  async _load() {
    const { slug } = this.props.params || {};
    const postSlug = this.props.query?.slug;
    const page = parseInt(this.props.query?.page || '1', 10);
    const timelineRange = this._parseTimelineParam(this.props.query?.timeline);

    if (!slug) {
      this.setState({ loading: false, error: 'Invalid tag URL.' });
      return;
    }

    const apiParams = { page };
    if (timelineRange) {
      apiParams.year_from = timelineRange.from;
      apiParams.year_to = timelineRange.to;
    }

    try {
      const data = await getTagPage(slug, apiParams);

      if (postSlug) {
        const post = await getPostBySlug(postSlug);
        document.title = `${post.title} — ${data.tag?.name || slug}`;
        setCanonical(`${window.location.origin}/posts/${post.slug}`);
        this.setState({ loading: false, data, post, error: null });
      } else {
        document.title = `${data.tag?.name || slug} — Posts`;
        const pageNum = parseInt(this.props.query?.page || '1', 10);
        const canonicalUrl = pageNum > 1
          ? `${window.location.origin}/tag/${slug}?page=${pageNum}`
          : `${window.location.origin}/tag/${slug}`;
        setCanonical(canonicalUrl);
        this.setState({ loading: false, data, post: null, error: null });
      }
    } catch (err) {
      const msg = err.status === 404 ? 'Not found.' : (err.message || 'Failed to load.');
      this.setState({ loading: false, data: null, post: null, error: msg });
    }
  }
}
