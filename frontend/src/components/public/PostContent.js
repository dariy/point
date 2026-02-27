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
import { escapeHtml, safeUrl, navigate } from '../../utils/helpers.js';
import { renderTagLink } from '../../utils/tags.js';

const IDLE_MS = 5000;   // hide UI after 5 s of inactivity
const MIN_SHOW_MS = 3000; // UI must be visible ≥ 3 s before click-to-hide works

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'ogv', 'm4v', 'avi', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'ogg', 'wav', 'flac', 'aac', 'opus']);

/** Return 'video', 'audio', or null based on file extension. */
function mediaTypeFromPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

/**
 * Returns true when the post should render in immersive (full-screen) mode.
 * Exported so PostPage can use the same check to configure its child components.
 */
export function shouldUseImmersive(post) {
  if (!post) return false;

  const media = post.media || [];
  // Audio-only attachment posts stay in normal layout
  if (media.length && media.every((m) => m.type === 'audio')) return false;

  // Strip all HTML tags; what remains is the visible text.
  const text = (post.content_html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

  // If there is text, check whether every non-empty line is a bare media path.
  // If so it counts as media, not prose.
  if (text.length !== 0) {
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const allMedia = lines.every((l) => /^(?:https?:\/\/|\/)\S+$/.test(l) && mediaTypeFromPath(l));
    if (!allMedia) return false;
  }

  const hasVisualMedia = media.some((m) => m.type !== 'audio');
  const hasContentMedia = (post.content_html || '').trim().length > 0;
  return hasVisualMedia || hasContentMedia;
}

export class PostContent extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._idleTimer = null;
    this._lastShowTime = 0;
    this._listeners = []; // [target, type, fn, opts]
  }

  render() {
    const { post, prevPost = null, nextPost = null, forceImmersive = false } = this.props;
    if (!post) return '';
    return (forceImmersive || shouldUseImmersive(post))
      ? this._renderImmersive(post, prevPost, nextPost)
      : this._renderNormal(post, prevPost, nextPost);
  }

  afterRender() {
    const { post, forceImmersive = false } = this.props;
    if (!post) return;
    if (forceImmersive || shouldUseImmersive(post)) {
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
  }

  // ── Immersive rendering ───────────────────────────────────────────────────

  _renderImmersive(post, _prevPost, _nextPost) {
    const media = post.media || [];
    const items = media.length > 0 ? media : this._mediaFromHtml(post.content_html || '');
    const startIndex = Math.min(this.props.startIndex || 0, Math.max(0, items.length - 1));
    const visuals = items.length === 1
      ? this._mediaEl(items[0])
      : this._renderCarousel(items, startIndex);

    const { showViewCount = false } = this.props;
    const viewCount = showViewCount && post.view_count != null
      ? `<span class="view-count">${escapeHtml(String(post.view_count))} views</span>` : '';

    const content = post.content_html
      ? `<div class="post-content-scrollable post-content">${post.content_html}</div>` : '';

    return `
      <div class="immersive-wrapper">
        <div class="immersive-visuals">${visuals}</div>

      </div>`;
  }

  _renderCarousel(media, startIndex = 0) {
    const slides = media.map((item, i) => `
      <div class="carousel-slide${i === startIndex ? ' active' : ''}" data-index="${i}">
        ${this._mediaEl(item)}
      </div>`).join('');

    const dots = media.map((_, i) => `
      <button class="carousel-dot${i === startIndex ? ' active' : ''}"
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

  /** Extract image/video/audio items from HTML, including bare media paths in text. */
  _mediaFromHtml(html) {
    const items = [];
    for (const m of html.matchAll(/<img[^>]+>/gi)) {
      const src = (m[0].match(/\ssrc="([^"]*)"/i) || [])[1] || '';
      const alt = (m[0].match(/\salt="([^"]*)"/i) || [])[1] || '';
      if (src) items.push({ type: 'image', url: src, alt });
    }
    for (const m of html.matchAll(/<(?:video|source)[^>]*\ssrc="([^"]*)"[^>]*/gi)) {
      if (m[1]) items.push({ type: 'video', url: m[1] });
    }
    for (const m of html.matchAll(/<audio[^>]*\ssrc="([^"]*)"[^>]*/gi)) {
      if (m[1]) items.push({ type: 'audio', url: m[1] });
    }
    // Fallback: bare media paths rendered as plain text by the markdown parser.
    if (items.length === 0) {
      const text = html.replace(/<[^>]+>/g, '').trim();
      for (const line of text.split(/\n+/)) {
        const url = line.trim();
        if (!url) continue;
        const type = mediaTypeFromPath(url);
        if (type) items.push({ type, url });
      }
    }
    return items;
  }

  // ── Immersive interactivity ───────────────────────────────────────────────

  _initImmersive() {
    const { prevPost = null, nextPost = null, tagSlug } = this.props;

    // ── Carousel helpers ──
    const carousel = this.$('#immersive-carousel');
    const slides = carousel ? Array.from(carousel.querySelectorAll('.carousel-slide')) : [];
    const dots   = carousel ? Array.from(carousel.querySelectorAll('.carousel-dot'))   : [];
    let index = Math.min(this.props.startIndex || 0, Math.max(0, slides.length - 1));

    const goToPost = (post) => {
      if (!post) return;
      navigate(tagSlug ? `/tag/${tagSlug}?slug=${post.slug}` : `/post/${post.slug}`);
    };

    const goTo = (i) => {
      const n = slides.length;
      if (!n) {
        // Single image: arrow keys navigate between posts
        if (i < 0) goToPost(prevPost);
        else if (i > 0) goToPost(nextPost);
        return;
      }
      const newIndex = ((i % n) + n) % n;
      // At boundaries with no wrap intended: navigate to adjacent post
      if (i < 0 && newIndex === n - 1 && slides.length > 1) {
        goToPost(prevPost);
        return;
      }
      if (i >= n && newIndex === 0 && slides.length > 1) {
        goToPost(nextPost);
        return;
      }
      slides[index]?.querySelector('video')?.pause();
      index = newIndex;
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
    let tx = 0, ty = 0, didSwipe = false;
    this._on(wrapper, 'touchstart', (e) => {
      tx = e.changedTouches[0].clientX;
      ty = e.changedTouches[0].clientY;
      didSwipe = false;
    }, { passive: true });
    this._on(wrapper, 'touchend', (e) => {
      const dx = e.changedTouches[0].clientX - tx;
      const dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        didSwipe = true;
        goTo(index + (dx < 0 ? 1 : -1));
      }
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
      const navKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
      if (e?.type === 'keydown' && navKeys.includes(e.key)) return;
      showUI();
    };

    this._on(document, 'mousemove',  resetIdle, { passive: true });
    this._on(document, 'mousedown',  resetIdle, { passive: true });
    this._on(document, 'keydown',    resetIdle, { passive: true });

    // ── Keyboard ──
    this._on(document, 'keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const n = slides.length;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault(); goTo(index - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault(); goTo(index + 1);
      } else if (e.key === 'Home') {
        e.preventDefault(); goTo(0);
      } else if (e.key === 'End') {
        e.preventDefault(); goTo(n > 0 ? n - 1 : 0);
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (document.body.classList.contains('ui-hidden')) {
          showUI();
        } else if (Date.now() - this._lastShowTime >= MIN_SHOW_MS) {
          hideUI();
          clearTimeout(this._idleTimer);
        }
      }
    });

    // ── Click / tap on image or wrapper to navigate or toggle UI ──
    this._on(wrapper, 'click', (e) => {
      if (didSwipe) { didSwipe = false; return; }
      if (e.target.closest('a, button, input, .post-info-card')) return;

      const x = e.clientX;
      const width = window.innerWidth;

      // Click on left/right 30% of screen to navigate
      if (x < width * 0.3) {
        goTo(index - 1);
      } else if (x > width * 0.7) {
        goTo(index + 1);
      } else {
        // Center click: toggle UI
        if (document.body.classList.contains('ui-hidden')) {
          showUI();
        } else if (Date.now() - this._lastShowTime >= MIN_SHOW_MS) {
          hideUI();
          clearTimeout(this._idleTimer);
        }
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
    const tags = (post.tags || []).map((t) => renderTagLink(t)).join('');
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);

    return `
      <article class="post-single${isHidden ? ' is-hidden' : ''}" itemscope itemtype="https://schema.org/BlogPosting">
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
    const { onEnterImmersive } = this.props;
    if (onEnterImmersive) {
      const images = Array.from(body.querySelectorAll('img')).filter(
        (img) => !img.closest('a[href]')
      );
      images.forEach((img, i) => {
        img.style.cursor = 'zoom-in';
        img.setAttribute('tabindex', '0');
        const enter = () => onEnterImmersive(i);
        img.addEventListener('click', enter);
        img.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(); }
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
