/**
 * PostContent — renders a post in normal layout or full-screen immersive mode.
 *
 * Immersive mode activates when the post has image/video media and little/no text.
 * It renders a full-viewport carousel with auto-hiding UI, keyboard navigation,
 * touch swipe, and a toggleable info overlay.
 *
 * Props:
 *   post           {object}      Full post from GET /api/posts/slug/:slug
 *   showViewCount  {boolean}
 *   prevPost       {object|null}
 *   nextPost       {object|null}
 */

import { Component } from '../Component.js';
import { escapeHtml, safeUrl } from '../../utils/helpers.js';
import { formatDate, isoDatetime } from '../../utils/formatters.js'; // used in _renderNormal
import { MediaLightbox } from './MediaLightbox.js';

const IDLE_MS = 5000;   // hide UI after 5 s of inactivity
const MIN_SHOW_MS = 3000; // UI must be visible ≥ 3 s before click-to-hide works

/**
 * Returns true when the post should render in immersive (full-screen) mode.
 * Exported so PostPage can use the same check to configure its child components.
 */
export function shouldUseImmersive(post) {
  if (!post) return false;
  const media = post.media || [];
  if (!media.length) return false;
  // Audio-only posts keep the normal layout
  if (media.every((m) => m.type === 'audio')) return false;
  // Posts with substantial text stay in normal layout
  const text = (post.content_html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return text.length < 300;
}

export class PostContent extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._lightbox = null;
    this._idleTimer = null;
    this._lastShowTime = 0;
    this._listeners = []; // [target, type, fn, opts]
  }

  render() {
    const { post, prevPost = null, nextPost = null } = this.props;
    if (!post) return '';
    return shouldUseImmersive(post)
      ? this._renderImmersive(post, prevPost, nextPost)
      : this._renderNormal(post, prevPost, nextPost);
  }

  afterRender() {
    const { post } = this.props;
    if (!post) return;
    if (shouldUseImmersive(post)) {
      document.body.classList.add('immersive-layout');
      this._initImmersive();
    } else {
      const bodyEl = this.$('.post-content');
      if (bodyEl) this._enhanceMedia(bodyEl);
    }
  }

  beforeUnmount() {
    document.body.classList.remove('immersive-layout', 'ui-hidden');
    this._listeners.forEach(([t, type, fn, opts]) => t.removeEventListener(type, fn, opts));
    this._listeners = [];
    clearTimeout(this._idleTimer);
    if (this._lightbox) { this._lightbox.destroy(); this._lightbox = null; }
  }

  // ── Immersive rendering ───────────────────────────────────────────────────

  _renderImmersive(post, prevPost, nextPost) {
    const media = post.media || [];
    const visuals = media.length === 1
      ? this._mediaEl(media[0])
      : this._renderCarousel(media);

    return `
      <div class="immersive-wrapper">
        <div class="immersive-visuals">${visuals}</div>
      </div>`;
  }

  _renderCarousel(media) {
    const slides = media.map((item, i) => `
      <div class="carousel-slide${i === 0 ? ' active' : ''}" data-index="${i}">
        ${this._mediaEl(item)}
      </div>`).join('');

    const dots = media.map((_, i) => `
      <button class="carousel-dot${i === 0 ? ' active' : ''}"
              data-index="${i}" aria-label="Media ${i + 1} of ${media.length}"></button>`
    ).join('');

    return `
      <div class="carousel-container" id="immersive-carousel">
        ${slides}
        <button class="carousel-prev" aria-label="Previous">&#10094;</button>
        <button class="carousel-next" aria-label="Next">&#10095;</button>
        <div class="carousel-indicators">${dots}</div>
      </div>`;
  }

  _mediaEl(item) {
    const url = safeUrl(item.url);
    if (item.type === 'video') {
      return `<video src="${url}" class="immersive-bg-image" autoplay muted loop playsinline></video>`;
    }
    if (item.type === 'audio') {
      return `<div class="immersive-audio-container">
                <audio src="${url}" class="immersive-audio-player" controls></audio>
              </div>`;
    }
    return `<img src="${url}" alt="${escapeHtml(item.alt || '')}" class="immersive-bg-image" loading="lazy">`;
  }

  // ── Immersive interactivity ───────────────────────────────────────────────

  _initImmersive() {
    let index = 0;

    // ── Carousel helpers ──
    const carousel = this.$('#immersive-carousel');
    const slides = carousel ? Array.from(carousel.querySelectorAll('.carousel-slide')) : [];
    const dots   = carousel ? Array.from(carousel.querySelectorAll('.carousel-dot'))   : [];

    const goTo = (i) => {
      const n = slides.length;
      if (!n) return;
      slides[index]?.querySelector('video')?.pause();
      index = ((i % n) + n) % n;
      slides.forEach((s, j) => s.classList.toggle('active', j === index));
      dots.forEach((d, j)   => d.classList.toggle('active', j === index));
      slides[index]?.querySelector('video')?.play().catch(() => {});
    };

    if (carousel) {
      this._on(carousel.querySelector('.carousel-prev'), 'click',
        (e) => { e.stopPropagation(); goTo(index - 1); });
      this._on(carousel.querySelector('.carousel-next'), 'click',
        (e) => { e.stopPropagation(); goTo(index + 1); });
      dots.forEach((d, i) =>
        this._on(d, 'click', (e) => { e.stopPropagation(); goTo(i); }));
    }

    // ── Touch swipe ──
    const wrapper = this.$('.immersive-wrapper');
    let tx = 0, ty = 0;
    this._on(wrapper, 'touchstart', (e) => {
      tx = e.changedTouches[0].clientX;
      ty = e.changedTouches[0].clientY;
    }, { passive: true });
    this._on(wrapper, 'touchend', (e) => {
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) goTo(index + (dx < 0 ? 1 : -1));
    }, { passive: true });

    // ── UI show / hide ──
    const showUI = () => {
      document.body.classList.remove('ui-hidden');
      this._lastShowTime = Date.now();
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(hideUI, IDLE_MS);
    };
    const hideUI = () => document.body.classList.add('ui-hidden');

    const resetIdle = (e) => {
      if (e?.type === 'keydown' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      if (e?.type === 'touchstart' && document.body.classList.contains('ui-hidden')) return;
      showUI();
    };

    this._on(document, 'mousemove',  resetIdle, { passive: true });
    this._on(document, 'mousedown',  resetIdle, { passive: true });
    this._on(document, 'touchstart', resetIdle, { passive: true });
    this._on(document, 'keydown',    resetIdle, { passive: true });

    // ── Keyboard ──
    this._on(document, 'keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); goTo(index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(index + 1); }
      else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (document.body.classList.contains('ui-hidden')) {
          showUI();
        } else if (Date.now() - this._lastShowTime >= MIN_SHOW_MS) {
          hideUI();
          clearTimeout(this._idleTimer);
        }
      }
    });

    // ── Click / tap to toggle UI ──
    this._on(wrapper, 'click', (e) => {
      if (e.target.closest('a, button, input')) return;
      if (document.body.classList.contains('ui-hidden')) {
        showUI();
      } else if (Date.now() - this._lastShowTime >= MIN_SHOW_MS) {
        hideUI();
        clearTimeout(this._idleTimer);
      }
    });

    // Start with UI visible, then auto-hide
    this._lastShowTime = Date.now();
    this._idleTimer = setTimeout(hideUI, IDLE_MS);
  }

  /** Register a listener and track it for cleanup. */
  _on(target, type, fn, opts) {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  // ── Normal layout ─────────────────────────────────────────────────────────

  _renderNormal(post, prevPost, nextPost) {
    const { showViewCount = false } = this.props;

    const tags = (post.tags || []).map((t) => {
      const slug = typeof t === 'string' ? t : t.slug;
      const name = typeof t === 'string' ? t : t.name;
      return `<a href="/tag/${escapeHtml(slug)}" class="post-tag">${escapeHtml(name)}</a>`;
    }).join('');

    const viewCount = showViewCount && post.view_count != null
      ? `<span class="view-count">${escapeHtml(String(post.view_count))} views</span>` : '';

    return `
      <article class="post-single" itemscope itemtype="https://schema.org/BlogPosting">
        <header class="post-header">
          <h1 class="post-title" itemprop="headline">${escapeHtml(post.title)}</h1>
          <div class="post-meta">
            <time class="post-date"
                  datetime="${escapeHtml(isoDatetime(post.published_at || post.created_at))}">
              ${escapeHtml(formatDate(post.published_at || post.created_at))}
            </time>
            ${viewCount}
          </div>
        </header>

        <div class="post-content" itemprop="articleBody">${post.content_html || ''}</div>

        ${tags
          ? `<footer class="post-footer">
               <div class="post-tags" aria-label="Tags">${tags}</div>
             </footer>`
          : ''}

        ${this._renderNav(prevPost, nextPost)}
      </article>`;
  }

  _enhanceMedia(body) {
    const images = Array.from(body.querySelectorAll('img')).filter(
      (img) => !img.closest('a[href]')
    );
    if (images.length) {
      this._lightbox = new MediaLightbox();
      const data = images.map((img) => ({ src: img.src, alt: img.alt || img.title || '' }));
      images.forEach((img, i) => {
        img.style.cursor = 'zoom-in';
        img.setAttribute('tabindex', '0');
        const open = () => this._lightbox.open(data, i);
        img.addEventListener('click', open);
        img.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
      });
    }
    body.querySelectorAll('audio, video').forEach((el) => el.setAttribute('controls', ''));
  }

  _renderNav(prev, next) {
    if (!prev && !next) return '';
    const prevLink = prev
      ? `<a href="/post/${escapeHtml(prev.slug)}" class="post-nav-link prev" rel="prev">
           <span class="nav-label">Previous</span>
           <span class="nav-title">${escapeHtml(prev.title)}</span>
         </a>` : '<span></span>';
    const nextLink = next
      ? `<a href="/post/${escapeHtml(next.slug)}" class="post-nav-link next" rel="next">
           <span class="nav-label">Next</span>
           <span class="nav-title">${escapeHtml(next.title)}</span>
         </a>` : '<span></span>';
    return `<nav class="post-navigation" aria-label="Post navigation">${prevLink}${nextLink}</nav>`;
  }
}
