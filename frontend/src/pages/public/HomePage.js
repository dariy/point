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
import { PostContent, shouldUseImmersive } from '../../components/public/PostContent.js';
import { ExploreBlock } from '../../components/public/ExploreBlock.js';
import { Timeline } from '../../components/public/Timeline.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { getHomePage } from '../../api/pages.js';
import { store } from '../../store.js';
import { escapeHtml, normalizeSettings } from '../../utils/helpers.js';
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';
import { FilterChipsRow } from '../../components/public/FilterChipsRow.js';
import { ViewContext } from '../../utils/viewContext.js';

export default class HomePage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, error: null, forceImmersive: false, startIndex: 0 };
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

    const settings = store.get('settings') || {};
    const { data } = this.state;
    const isStaticHomePage = data && !!settings.home_page_post_id && data.pagination?.total === 1 && data.posts?.length === 1;

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        ${isStaticHomePage ? '' : '<div id="tag-cloud-mount"></div>'}
        ${isStaticHomePage ? '' : '<div id="timeline-mount"></div>'}
        <div id="filter-chips-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount" class="${isStaticHomePage ? '' : 'grid-expand-mount'}"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    const { data, forceImmersive, startIndex } = this.state;
    const isStaticHomePage = data && !!settings.home_page_post_id && data.pagination?.total === 1 && data.posts?.length === 1;
    const post = isStaticHomePage ? data.posts[0] : null;
    const immersive = forceImmersive || (isStaticHomePage && shouldUseImmersive(post));

    if (immersive) {
      document.body.classList.add('immersive-layout');
    } else {
      document.body.classList.remove('immersive-layout', 'ui-hidden');
    }

    this._gesture?.destroy();
    this._trackpad?.destroy();
    const navTags = store.get('navTags') || [];

    // In immersive mode suppress the tag filter bar (post tags go in the footer instead),
    // but keep the custom menu visible since it contains explicit navigation links.
    const isCustomMenu = settings.nav_menu_mode === 'custom';
    this.mountChild(PublicHeader, '#header-mount', {
      settings,
      currentPath: '/',
      navTags: (immersive && !isCustomMenu) ? [] : navTags,
      editUrl: (isStaticHomePage && post) ? `/light/posts/${post.id}/edit` : null,
    });

    const immersiveTags = (isStaticHomePage && immersive) ? (post.tags || []) : [];
    this.mountChild(PublicFooter, '#footer-mount', { settings, immersiveTags });

    if (this.state.loading || !this.state.data) return;

    const { posts = [], pagination = {}, tag_cloud: tagCloud = [] } = this.state.data;
    const showViewCount = !!settings.show_view_counts;
    const useThumbnails = settings.use_thumbnails !== false;

    if (isStaticHomePage) {
      this.mountChild(PostContent, '#grid-mount', {
        post: posts[0],
        showViewCount,
        showImmersiveExcerpt: settings.show_immersive_excerpt !== 'false',
        forceImmersive: immersive,
        startIndex: startIndex,
        onEnterImmersive: (idx = 0) => {
          const hash = idx === 0 ? "" : `#${idx + 1}`;
          window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
          this.setState({ forceImmersive: true, startIndex: idx });
        },
      });
    } else {
      this.mountChild(PostGrid, '#grid-mount', { posts, showViewCount, useThumbnails });
    }

    if (!isStaticHomePage && !!settings.show_tag_cloud && tagCloud.length) {
      this.mountChild(ExploreBlock, '#tag-cloud-mount', { tags: tagCloud });
    }

    const canShowTimeline = !isStaticHomePage && (settings.timeline_mode === 'all' || (store.get('user') && settings.timeline_mode === 'hidden'));
    if (canShowTimeline) {
      const vc = ViewContext.current();
      this.mountChild(Timeline, '#timeline-mount', {
        mode: 'filter',
        initialRange: vc.years ? { from: vc.years[0], to: vc.years[1] } : undefined,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
      });
    }

    const vc = ViewContext.current();
    if (!vc.isDefault() && this.state.data) {
      this.mountChild(FilterChipsRow, '#filter-chips-mount', {
        total: this.state.data.pagination?.total || this.state.data.total || 0,
      });
    }

    if (pagination.pages > 1) {
      this.mountChild(Pagination, '#pagination-mount', {
        page: pagination.page,
        pages: pagination.pages,
        total: pagination.total,
        onPage: (p) => ViewContext.update({ page: p }),
      });
    }

    // Always set up gestures so horizontal swipes are captured and rubber-banded
    // even on single-page lists (prevents browser history back/forward).
    {
      const gridMount = this.$('#grid-mount');
      let previewEl = null;      this._gesture = new GestureController(this.$('.site-main'), {
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

            // Create placeholder for next page if it doesn't exist
            if (!previewEl) {
              previewEl = document.createElement('div');
              previewEl.className = 'grid-preview-placeholder';
              // Simple skeleton indication
              previewEl.innerHTML = `
                <div class="posts-grid placeholder-grid" style="opacity: 0.5;">
                  <div class="post-card-slot"></div>
                  <div class="post-card-slot"></div>
                  <div class="post-card-slot"></div>
                  <div class="post-card-slot"></div>
                </div>
              `;
              gridMount.parentElement.appendChild(previewEl);
              
              // Start prefetching the next page data in parallel
              const targetPage = dx < 0 ? pagination.page + 1 : pagination.page - 1;
              getHomePage({ page: targetPage }).then((data) => {
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

            // Position the placeholder on the correct side
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
          if (dir === 'left' && pagination.page < pagination.pages) {
            ViewContext.update({ page: pagination.page + 1 });
          } else if (dir === 'right' && pagination.page > 1) {
            ViewContext.update({ page: pagination.page - 1 });
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
          if (dir === 'left' && pagination.page < pagination.pages) {
            ViewContext.update({ page: pagination.page + 1 });
          } else if (dir === 'right' && pagination.page > 1) {
            ViewContext.update({ page: pagination.page - 1 });
          }
        }
      });
    }
  }  _onTimelineRangeChange({ from, to, isFullExtent }) {
    const years = isFullExtent ? null : [from, to];
    const vc = ViewContext.current();
    const same = years
      ? vc.years && vc.years[0] === years[0] && vc.years[1] === years[1]
      : !vc.years;
    if (same) return;
    ViewContext.update({ years });
  }

  beforeUnmount() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const vc = ViewContext.current();
    const params = { page: vc.page };
    if (vc.years) {
      params.year_from = vc.years[0];
      params.year_to = vc.years[1];
    }
    if (vc.query) params.q = vc.query;
    if (vc.tag) params.tag = vc.tag;

    try {
      const data = await getHomePage(params);
      // Merge settings from page response into store.
      if (data.settings) store.set('settings', { ...store.get('settings'), ...normalizeSettings(data.settings) });

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

      this.setState({ loading: false, data, error: null, startIndex, forceImmersive });
    } catch (err) {
      this.setState({ loading: false, data: null, error: err.message || 'Failed to load posts.' });
    }
  }
}
