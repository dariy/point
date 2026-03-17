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
import { escapeHtml, navigate, normalizeSettings } from '../../utils/helpers.js';
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';

export default class HomePage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, error: null };
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

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        <div id="tag-cloud-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }  afterRender() {
    document.body.classList.remove('immersive-layout', 'ui-hidden');
    this._gesture?.destroy();
    this._trackpad?.destroy();
    const settings = store.get('settings') || {};
    const navTags = (this.state.data?.menu) || store.get('navTags') || [];
    if (navTags.length) store.set('navTags', navTags);
    this.mountChild(PublicHeader, '#header-mount', { settings, currentPath: '/', navTags });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    if (this.state.loading || !this.state.data) return;

    const { posts = [], pagination = {}, tag_cloud: tagCloud = [] } = this.state.data;
    const showViewCount = !!settings.show_view_counts;
    const useThumbnails = settings.use_thumbnails !== false;

    this.mountChild(PostGrid, '#grid-mount', { posts, showViewCount, useThumbnails });

    if (!!settings.show_tag_cloud && tagCloud.length) {
      this.mountChild(TagCloud, '#tag-cloud-mount', { tags: tagCloud });
    }

    if (pagination.pages > 1) {
      this.mountChild(Pagination, '#pagination-mount', {
        page: pagination.page,
        pages: pagination.pages,
        total: pagination.total,
        onPage: (p) => navigate(`/?page=${p}`),
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
              previewEl.style.position = 'absolute';
              previewEl.style.top = '0';
              previewEl.style.width = '100%';
              gridMount.parentElement.style.position = 'relative';
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
            navigate(`/?page=${pagination.page + 1}`);
          } else if (dir === 'right' && pagination.page > 1) {
            navigate(`/?page=${pagination.page - 1}`);
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
            navigate(`/?page=${pagination.page + 1}`);
          } else if (dir === 'right' && pagination.page > 1) {
            navigate(`/?page=${pagination.page - 1}`);
          }
        }
      });
    }
  }  beforeUnmount() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
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
      if (data.settings) store.set('settings', { ...store.get('settings'), ...normalizeSettings(data.settings) });
      this.setState({ loading: false, data, error: null });
    } catch (err) {
      this.setState({ loading: false, data: null, error: err.message || 'Failed to load posts.' });
    }
  }
}
