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
import { GestureController, TrackpadDetector } from '../../utils/gestures.js';

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
    this._zoomState = { scale: 1, x: 0, y: 0 };
  }

  render() {
    const { post, prevPost = null, nextPost = null, forceImmersive = false } = this.props;
    if (!post) return '';
    return (forceImmersive || shouldUseImmersive(post))
      ? this._renderImmersive(post, prevPost, nextPost)
      : this._renderNormal(post, prevPost, nextPost);
  }

  afterRender() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
    const { post, prevPost = null, nextPost = null, forceImmersive = false } = this.props;
    if (!post) return;
    if (forceImmersive || shouldUseImmersive(post)) {
      document.body.classList.add('immersive-layout');
      this._initImmersive();
    } else {
      const bodyEl = this.$('.post-content');
      if (bodyEl) this._enhanceMedia(bodyEl);
      if (prevPost || nextPost) this._initNormal(prevPost, nextPost);
    }
  }

  beforeUnmount() {
    document.body.classList.remove('immersive-layout', 'ui-hidden');
    this._listeners.forEach(([t, type, fn, opts]) => t.removeEventListener(type, fn, opts));
    this._listeners = [];
    clearTimeout(this._idleTimer);
    this._gesture?.destroy();
    this._trackpad?.destroy();
  }

  // ── Immersive rendering ───────────────────────────────────────────────────

  _renderImmersive(post, _prevPost, _nextPost) {
    const media = post.media || [];
    const items = media.length > 0 ? media : this._mediaFromHtml(post.content_html || '');
    const startIndex = Math.min(this.props.startIndex || 0, Math.max(0, items.length - 1));
    const visuals = items.length === 1
      ? this._mediaEl(items[0])
      : this._renderCarousel(items, startIndex);

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
    const { prevPost = null, nextPost = null, tagSlug, post } = this.props;

    // ── Carousel helpers ──
    const carousel = this.$('#immersive-carousel');
    const slides = carousel ? Array.from(carousel.querySelectorAll('.carousel-slide')) : [];
    const dots   = carousel ? Array.from(carousel.querySelectorAll('.carousel-dot'))   : [];
    let index = Math.min(this.props.startIndex || 0, Math.max(0, slides.length - 1));

    const goToPost = (p) => {
      if (!p) return;
      const target = slides[index] ?? this.$('.immersive-visuals');
      if (target) {
        target.style.transition = 'opacity 0.5s ease';
        target.style.opacity = '0';
      }
      setTimeout(() => {
        navigate(tagSlug ? `/tag/${tagSlug}?slug=${p.slug}` : `/post/${p.slug}`);
      }, 500);
    };

    const goTo = (i) => {
      const n = slides.length;
      if (!n) {
        // Single image: reversed direction logic
        // Swipe left (next) -> older (prevPost)
        // Swipe right (prev) -> newer (nextPost)
        if (i < 0) goToPost(nextPost);
        else if (i > 0) goToPost(prevPost);
        return;
      }
      const newIndex = ((i % n) + n) % n;
      // Boundaries
      if (i < 0 && newIndex === n - 1 && slides.length > 1) {
        if (nextPost) { goToPost(nextPost); return; }
      }
      if (i >= n && newIndex === 0 && slides.length > 1) {
        if (prevPost) { goToPost(prevPost); return; }
      }
      slides[index]?.querySelector('video')?.pause();
      index = newIndex;
      slides.forEach((s, j) => s.classList.toggle('active', j === index));
      dots.forEach((d, j)   => d.classList.toggle('active', j === index));
      slides[index]?.querySelector('video')?.play().catch(() => {});
      this._resetZoom();
    };

    if (carousel) {
      this._on(carousel.querySelector('.carousel-prev'), 'click',
        (e) => { e.stopPropagation(); goTo(index - 1); });
      this._on(carousel.querySelector('.carousel-next'), 'click',
        (e) => { e.stopPropagation(); goTo(index + 1); });
      dots.forEach((d, i) =>
        this._on(d, 'click', (e) => { e.stopPropagation(); goTo(i); }));
    }

    // Fade in on mount
    const fadeTarget = slides.length > 0 ? slides[index] : this.$('.immersive-visuals');
    fadeTarget?.classList.add('immersive-fade-in');

    // ── Gestures & Zoom ──
    const wrapper = this.$('.immersive-wrapper');
    const visuals = this.$('.immersive-visuals');
    
    this._resetZoom = () => {
      this._zoomState = { scale: 1, x: 0, y: 0 };
      this._updateVisuals(0, 0);
      this._gesture?.setZoomed(false);
      wrapper.classList.remove('zoomed');
    };

    const getMaxScale = () => {
      const img = (slides[index] ?? visuals).querySelector('img, video');
      if (!img || !img.complete && img.tagName === 'IMG') return 2;
      const rect = img.getBoundingClientRect();
      const naturalWidth = img.naturalWidth || img.videoWidth;
      if (!naturalWidth) return 2;
      const max = naturalWidth / rect.width;
      return max > 1 ? max : 1;
    };

    this._updateVisuals = (dx = 0, dy = 0) => {
      const { scale, x, y } = this._zoomState;
      const tx = x + dx;
      const ty = y + dy;
      const target = slides[index] ?? visuals;
      if (!target) return;
      
      if (scale === 1) {
        // Swipe feedback
        if (Math.abs(tx) > Math.abs(ty)) {
          target.style.transform = `translateX(${tx}px)`;
          target.style.opacity = Math.max(0.3, 1 - Math.abs(tx) / window.innerWidth);
        } else if (ty > 0) {
          const s = Math.max(0.5, 1 - ty / window.innerHeight);
          target.style.transform = `translateY(${ty}px) scale(${s})`;
          target.style.opacity = s;
        } else {
          target.style.transform = '';
          target.style.opacity = '1';
        }
      } else {
        // Pan feedback
        target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        target.style.opacity = '1';
      }
      target.style.transition = 'none';
    };

    const dismiss = async () => {
      if (tagSlug) {
        navigate(`/tag/${tagSlug}`);
      } else {
        // Use the new API to find exactly which page to go back to
        try {
          const res = await fetch(`/api/posts/${post.slug}/page`);
          const data = await res.json();
          navigate(data.page > 1 ? `/?page=${data.page}` : '/');
        } catch (e) {
          navigate('/');
        }
      }
    };

    this._gesture = new GestureController(wrapper, {
      onSwipeMove: (dx, dy) => this._updateVisuals(dx, dy),
      onSwipeCancel: () => {
        const target = slides[index] ?? visuals;
        if (target) {
          target.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
          this._updateVisuals();
        }
      },
      onSwipeCommit: (dir) => {
        // Reversed horizontal direction: left (dx<0) -> next (older)
        if (dir === 'left') goTo(index + 1);
        else if (dir === 'right') goTo(index - 1);
        else if (dir === 'down') dismiss();
        else this._updateVisuals();
      },
      onPanMove: (dx, dy) => {
        this._zoomState.x += dx;
        this._zoomState.y += dy;
        this._updateVisuals();
      },
      onPinchMove: (delta, cx, cy) => {
        const oldScale = this._zoomState.scale;
        const newScale = Math.max(1, Math.min(getMaxScale(), oldScale * delta));
        if (newScale === oldScale) return;
        
        // Zoom relative to pinch center
        const rect = wrapper.getBoundingClientRect();
        const rx = cx - rect.left - rect.width / 2;
        const ry = cy - rect.top - rect.height / 2;
        
        this._zoomState.x -= (rx - this._zoomState.x) * (newScale / oldScale - 1);
        this._zoomState.y -= (ry - this._zoomState.y) * (newScale / oldScale - 1);
        this._zoomState.scale = newScale;
        
        this._gesture.setZoomed(newScale > 1);
        wrapper.classList.toggle('zoomed', newScale > 1);
        this._updateVisuals();
      },
      onTap: (x, y) => {
        if (document.body.classList.contains('ui-hidden')) {
          showUI();
        } else if (Date.now() - this._lastShowTime >= MIN_SHOW_MS) {
          hideUI();
          clearTimeout(this._idleTimer);
        }
      },
      onDoubleTap: (x, y) => {
        if (this._zoomState.scale > 1) {
          this._resetZoom();
        } else {
          const max = getMaxScale();
          if (max <= 1) return;
          const rect = wrapper.getBoundingClientRect();
          this._zoomState.scale = max;
          this._zoomState.x = (rect.width / 2 - (x - rect.left)) * (max - 1);
          this._zoomState.y = (rect.height / 2 - (y - rect.top)) * (max - 1);
          this._gesture.setZoomed(true);
          wrapper.classList.add('zoomed');
          this._updateVisuals();
        }
      }
    });

    this._trackpad = new TrackpadDetector(wrapper, {
      onHorizontal: (dir) => goTo(index + (dir === 'left' ? 1 : -1))
    });

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
      if (this._zoomState.scale > 1) {
        if (e.key === 'Escape') this._resetZoom();
        return;
      }
      const n = slides.length;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault(); goTo(index - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault(); goTo(index + 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); dismiss();
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

    // Start with UI visible, then auto-hide
    this._lastShowTime = Date.now();
    this._idleTimer = setTimeout(hideUI, IDLE_MS);
  }

  _initNormal(prevPost, nextPost) {
    this._gesture = new GestureController(this.container, {
      onSwipeMove: (dx, dy) => {
        if (Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0 && !prevPost) return; // swipe-left -> older (prev)
          if (dx > 0 && !nextPost) return; // swipe-right -> newer (next)
          this.container.style.transform = `translateX(${dx}px)`;
          this.container.style.transition = 'none';
          this.container.style.opacity = Math.max(0.3, 1 - Math.abs(dx) / (window.innerWidth || 500));
        }
      },
      onSwipeCancel: () => {
        this.container.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        this.container.style.transform = '';
        this.container.style.opacity = '1';
      },
      onSwipeCommit: (dir) => {
        if (dir === 'left' && prevPost) navigate('/post/' + prevPost.slug);
        else if (dir === 'right' && nextPost) navigate('/post/' + nextPost.slug);
        else {
          this.container.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
          this.container.style.transform = '';
          this.container.style.opacity = '1';
        }
      }
    });
    this._trackpad = new TrackpadDetector(this.container, {
      onHorizontal: (dir) => {
        if (dir === 'left' && prevPost) navigate('/post/' + prevPost.slug);
        else if (dir === 'right' && nextPost) navigate('/post/' + nextPost.slug);
      }
    });
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
