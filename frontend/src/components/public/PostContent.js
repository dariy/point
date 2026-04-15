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
import { buildTagIndex, renderTagStrip, setupTagStrip, hideFlyout } from '../../utils/tags.js';
import { store } from '../../store.js';
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';
import { getPostPageLocation } from '../../api/posts.js';

const IDLE_MS = 2000;   // hide UI after 5 s of inactivity
const MIN_SHOW_MS = 2000; // UI must be visible ≥ 3 s before click-to-hide works
let _overlayHidden = false; // persists across post navigations

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
      document.body.classList.remove('immersive-layout', 'ui-hidden');
      const bodyEl = this.$('.post-content');
      if (bodyEl) this._enhanceMedia(bodyEl);
      if (prevPost || nextPost) this._initNormal(prevPost, nextPost);

      this._cleanupStrip?.();
      if (!this._subscribed) {
        this.subscribeStore(store, 'navTags', () => this._rerender());
        this._subscribed = true;
      }

      const footer = this.$('.post-footer');
      if (footer) {
        const navTags = store.get('navTags') || [];
        const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
        this._cleanupStrip = setupTagStrip(footer, tagIndex, navigate);
      }
    }
  }

  beforeUnmount() {
    _overlayHidden = document.body.classList.contains('ui-hidden');
    // Body classes are kept intentionally — the next page's afterRender handles cleanup.
    // Keeping them prevents the overlay blink when navigating between immersive posts.
    this._listeners.forEach(([t, type, fn, opts]) => t.removeEventListener(type, fn, opts));
    this._listeners = [];
    clearTimeout(this._idleTimer);
    this._gesture?.destroy();
    this._trackpad?.destroy();
    this._cleanupStrip?.();
  }

  // ── Immersive rendering ───────────────────────────────────────────────────

  _exifVisible() {
    const settings = store.get('settings') || {};
    const v = settings.exif_visibility || 'hide';
    if (v === 'hide') return false;
    if (v === 'admin' && !store.get('user')) return false;
    return true;
  }

  _renderExifTable(metadata) {
    const entries = Object.entries(metadata || {});
    if (!entries.length) return '';
    const rows = entries.map(([k, v]) =>
      `<tr><td>${escapeHtml(String(k))}</td><td>${escapeHtml(String(v))}</td></tr>`
    ).join('');
    return `<table><tbody>${rows}</tbody></table>`;
  }

  _renderImmersive(post, prevPost, nextPost) {
    // Always derive carousel items from HTML — post.media has {path,metadata} shape for EXIF only
    const items = this._mediaFromHtml(post.content_html || '');
    const startIndex = Math.min(this.props.startIndex || 0, Math.max(0, items.length - 1));
    const visuals = items.length === 1
      ? this._mediaEl(items[0])
      : this._renderCarousel(items, startIndex);

    // Single-image posts have no carousel arrows, so add post-navigation arrows.
    const postNavArrows = items.length === 1
      ? this._renderImmersivePostNav(prevPost, nextPost)
      : '';

    const showExcerpt = this.props.showImmersiveExcerpt !== false;
    const excerptHtml = (showExcerpt && post.excerpt)
      ? `<div class="post-excerpt-card">${escapeHtml(post.excerpt)}</div>`
      : '';

    return `
      <div class="immersive-wrapper">
        <div class="immersive-visuals">${visuals}</div>
        ${postNavArrows}
        ${excerptHtml}
      </div>`;
  }

  /** Render prev/next post arrow buttons for single-image immersive posts. */
  _renderImmersivePostNav(prevPost, nextPost) {
    if (!prevPost && !nextPost) return '';
    const settings = store.get('settings') || {};
    const feedMode = settings.immersive_nav_direction === 'feed';
    const backPost = feedMode ? nextPost : prevPost;
    const fwdPost  = feedMode ? prevPost : nextPost;
    const prev = backPost
      ? `<button class="carousel-prev" aria-label="Previous post">&#10094;</button>`
      : '';
    const next = fwdPost
      ? `<button class="carousel-next" aria-label="Next post">&#10095;</button>`
      : '';
    return prev + next;
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

    // Direction aliases: backPost = ◁/ArrowLeft target; fwdPost = ▷/ArrowRight target.
    // 'feed' mode reverses so left→newer (matches top-left grid order).
    const settings = store.get('settings') || {};
    const feedMode = settings.immersive_nav_direction === 'feed';
    const backPost = feedMode ? nextPost : prevPost;
    const fwdPost  = feedMode ? prevPost : nextPost;

    // ── Carousel helpers ──
    const carousel = this.$('#immersive-carousel');
    const slides = carousel ? Array.from(carousel.querySelectorAll('.carousel-slide')) : [];
    const dots   = carousel ? Array.from(carousel.querySelectorAll('.carousel-dot'))   : [];
    let index = Math.min(this.props.startIndex || 0, Math.max(0, slides.length - 1));

    const goToPost = (p) => {
      if (!p) return;
      const target = slides[index] ?? visuals;
      if (target) {
        target.classList.remove('immersive-fade-in');
        target.classList.add('immersive-fade-out');
      }
      setTimeout(() => {
        navigate(tagSlug ? `/tag/${tagSlug}?slug=${p.slug}` : `/post/${p.slug}`);
      }, 400);
    };

    const goTo = (i) => {
      const n = slides.length;
      if (!n) {
        if (i < 0) goToPost(backPost);
        else if (i > 0) goToPost(fwdPost);
        return;
      }
      const newIndex = ((i % n) + n) % n;
      if (i < 0 && newIndex === n - 1 && slides.length > 1) {
        if (backPost) { goToPost(backPost); return; }
      }
      if (i >= n && newIndex === 0 && slides.length > 1) {
        if (fwdPost) { goToPost(fwdPost); return; }
      }

      const oldIndex = index;
      if (oldIndex === newIndex) return;

      // Update index immediately so gestures during transition reference the new slide.
      index = newIndex;

      const oldSlide = slides[oldIndex];
      const newSlide = slides[newIndex];

      // Hide old slide immediately to prevent it showing through the fading-in new slide.
      if (oldSlide) {
        oldSlide.querySelector('video')?.pause();
        oldSlide.classList.remove('active', 'immersive-fade-in', 'immersive-fade-out');
        // Clear inline styles set by _updateVisuals during swipe gestures.
        // Without this, style.transition='none' blocks the CSS fade-out and
        // style.opacity overrides CSS opacity:0, leaving the old slide visible.
        oldSlide.style.transform = '';
        oldSlide.style.opacity = '';
        oldSlide.style.transition = '';
      }

      // Activate and fade in the new slide.
      if (newSlide) {
        newSlide.classList.add('active', 'immersive-fade-in');
        newSlide.querySelector('video')?.play().catch(() => {});
      }

      dots.forEach((d, j) => d.classList.toggle('active', j === index));
      this._resetZoom();
    };

    if (carousel) {
      this._on(carousel.querySelector('.carousel-prev'), 'click',
        (e) => { e.stopPropagation(); goTo(index - 1); });
      this._on(carousel.querySelector('.carousel-next'), 'click',
        (e) => { e.stopPropagation(); goTo(index + 1); });
      dots.forEach((d, i) =>
        this._on(d, 'click', (e) => { e.stopPropagation(); goTo(i); }));
    } else {
      // Single-image post — wire up post-navigation arrows rendered by _renderImmersivePostNav.
      const wrapper = this.$('.immersive-wrapper');
      if (wrapper) {
        this._on(wrapper.querySelector('.carousel-prev'), 'click',
          (e) => { e.stopPropagation(); goToPost(backPost); });
        this._on(wrapper.querySelector('.carousel-next'), 'click',
          (e) => { e.stopPropagation(); goToPost(fwdPost); });
      }
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

    this._constrainZoom = (animate = false) => {
      const { scale } = this._zoomState;
      if (scale <= 1) {
        this._zoomState.x = 0;
        this._zoomState.y = 0;
        this._zoomState.scale = 1;
      } else {
        const img = (slides[index] ?? visuals).querySelector('img, video');
        if (img) {
          const rect = img.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const rangeX = Math.max(0, (rect.width - vw) / 2);
          const rangeY = Math.max(0, (rect.height - vh) / 2);
          this._zoomState.x = Math.max(-rangeX, Math.min(rangeX, this._zoomState.x));
          this._zoomState.y = Math.max(-rangeY, Math.min(rangeY, this._zoomState.y));
        }
      }
      const target = slides[index] ?? visuals;
      if (target && animate) {
        target.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease';
      }
      this._updateVisuals();
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
      try {
        const params = tagSlug ? { tag: tagSlug } : {};
        const data = await getPostPageLocation(post.slug, params);
        const url = tagSlug
          ? (data.page > 1 ? `/tag/${tagSlug}?page=${data.page}` : `/tag/${tagSlug}`)
          : (data.page > 1 ? `/?page=${data.page}` : '/');
        navigate(url);
      } catch {
        navigate(tagSlug ? `/tag/${tagSlug}` : '/');
      }
    };

    this._gesture = new GestureController(wrapper, {
      onSwipeMove: (dx, dy) => {
        if (Math.abs(dx) > Math.abs(dy)) {
          const n = slides.length;
          const atLastSlide  = n === 0 || index === n - 1;
          const atFirstSlide = n === 0 || index === 0;
          const blockedLeft  = dx < 0 && atLastSlide  && !fwdPost;
          const blockedRight = dx > 0 && atFirstSlide && !backPost;
          const blocked = blockedLeft || blockedRight;
          const tx = blocked ? rubberBand(dx) : dx;
          this._updateVisuals(tx, dy);
        } else {
          this._updateVisuals(dx, dy);
        }
      },
      onSwipeCancel: () => {
        if (this._zoomState.scale > 1) {
          this._constrainZoom(true);
        } else {
          const target = slides[index] ?? visuals;
          if (target) {
            target.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
            target.style.transform = '';
            target.style.opacity = '1';
          }
        }
      },
      onSwipeCommit: (dir) => {
        if (dir === 'left' || dir === 'right') {
          const n = slides.length;
          const atLastSlide  = n === 0 || index === n - 1;
          const atFirstSlide = n === 0 || index === 0;
          const blocked = (dir === 'left'  && atLastSlide  && !fwdPost)
                       || (dir === 'right' && atFirstSlide && !backPost);
          if (blocked) {
            // Spring back — same as onSwipeCancel
            const target = slides[index] ?? visuals;
            if (target) {
              target.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
              target.style.transform = '';
              target.style.opacity = '1';
            }
            return;
          }
        }
        // Swipe left = advance slide (index+1); at last slide crosses to nextPost (newer)
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
      onPinchEnd: () => {
        this._constrainZoom(true);
      },
      onPinchMove: (delta, cx, cy) => {
        const oldScale = this._zoomState.scale;
        const newScale = Math.max(0.5, Math.min(getMaxScale() * 2, oldScale * delta));
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
        // Don't hide/show the overlay when the tap landed on an interactive element
        // (nav arrows, info card, etc.) — those elements handle their own action.
        const tapped = document.elementFromPoint(x, y);
        if (tapped?.closest('a, button, input, .post-info-card')) return;
        if (document.body.classList.contains('ui-hidden')) {
          showUI();
        } else {
          _hideFromClickTime = Date.now();
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
    let _hideFromClickTime = 0;

    const showUI = () => {
      if (document.body.classList.contains('ui-hidden')) {
        document.body.classList.remove('ui-hidden');
        this._lastShowTime = Date.now();
      }
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(hideUI, IDLE_MS);
    };
    const hideUI = () => {
      if (document.querySelector('.header-search-form.is-active, .tag-group.is-open')) {
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(hideUI, IDLE_MS);
        return;
      }
      hideFlyout();
      document.body.classList.add('ui-hidden');
    };

    const resetIdle = (e) => {
      const navKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
      if (e?.type === 'keydown' && navKeys.includes(e.key)) return;
      // Suppress mousemove-triggered show for a short window after a deliberate click/tap hide,
      // otherwise the natural hand-wobble after clicking immediately re-shows the overlay.
      if (e?.type === 'mousemove' && document.body.classList.contains('ui-hidden')
          && Date.now() - _hideFromClickTime < 600) return;
      showUI();
    };

    // Pause the hide countdown while the user is pressing/touching;
    // restart it only after they release.
    const pauseCountdown = () => clearTimeout(this._idleTimer);
    const resumeCountdown = () => {
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(hideUI, IDLE_MS);
    };

    let lastTouchTime = 0;
    this._on(document, 'touchstart', () => {
      lastTouchTime = Date.now();
      pauseCountdown();
    }, { passive: true, capture: true });
    this._on(document, 'touchend',    resumeCountdown, { passive: true, capture: true });
    this._on(document, 'touchcancel', resumeCountdown, { passive: true, capture: true });

    this._on(wrapper, 'click', (e) => {
      if (Date.now() - lastTouchTime < 500) return; // Ignore simulated click from touch
      if (e.target.closest('a, button, input, .post-info-card')) return;
      if (document.body.classList.contains('ui-hidden')) {
        showUI();
      } else {
        _hideFromClickTime = Date.now();
        hideUI();
        clearTimeout(this._idleTimer);
      }
    });

    this._on(document, 'mousemove',  resetIdle,       { passive: true });
    this._on(document, 'mousedown',  pauseCountdown,  { passive: true });
    this._on(document, 'mouseup',    resumeCountdown, { passive: true });
    this._on(document, 'keydown',    resetIdle,       { passive: true });

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
      } else if (e.key === 'Escape' || e.key === 'ArrowDown') {
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

    // Restore overlay visibility from previous post, or start visible then auto-hide
    this._lastShowTime = Date.now();
    if (_overlayHidden) {
      hideUI();
    } else {
      this._idleTimer = setTimeout(hideUI, IDLE_MS);
    }
  }

  _initNormal(prevPost, nextPost) {
    // Direction aliases — same setting as immersive mode.
    const settings = store.get('settings') || {};
    const feedMode = settings.immersive_nav_direction === 'feed';
    const backPost = feedMode ? nextPost : prevPost;  // left swipe / ◁
    const fwdPost  = feedMode ? prevPost : nextPost;  // right swipe / ▷

    // No drag-transform feedback on a scrollable page — it fights browser scroll.
    // Just commit on a clean horizontal swipe.
    this._gesture = new GestureController(this.container, {
      onSwipeCommit: (dir) => {
        if (dir === 'left'  && backPost) navigate('/post/' + backPost.slug);
        else if (dir === 'right' && fwdPost)  navigate('/post/' + fwdPost.slug);
      }
    });
    this._trackpad = new TrackpadDetector(this.container, {
      onHorizontal: (dir) => {
        if (dir === 'left'  && backPost) navigate('/post/' + backPost.slug);
        else if (dir === 'right' && fwdPost)  navigate('/post/' + fwdPost.slug);
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
    const navTags = store.get('navTags') || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    const tags = renderTagStrip(post.tags, tagIndex);
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);

    return `
      <article class="post-single${isHidden ? ' is-hidden' : ''}" itemscope itemtype="https://schema.org/BlogPosting">
        <div class="post-content" itemprop="articleBody">${post.content_html || ''}</div>

        ${tags
          ? `<footer class="post-footer">
               ${tags}
             </footer>`
          : ''}

        ${this._renderNav(prevPost, nextPost)}
      </article>
      ${this._renderNormalPostArrows(prevPost, nextPost)}`;
  }

  /** Render fixed-position prev/next post arrow buttons for the normal (non-immersive) layout. */
  _renderNormalPostArrows(prevPost, nextPost) {
    if (!prevPost && !nextPost) return '';
    const prev = prevPost
      ? `<a href="/post/${escapeHtml(prevPost.slug)}" class="post-side-nav-btn prev" aria-label="Previous post">&#10094;</a>`
      : '';
    const next = nextPost
      ? `<a href="/post/${escapeHtml(nextPost.slug)}" class="post-side-nav-btn next" aria-label="Next post">&#10095;</a>`
      : '';
    return `<nav class="post-side-nav" aria-label="Post side navigation">${prev}${next}</nav>`;
  }

  _enhanceMedia(body) {
    const { onEnterImmersive, post } = this.props;
    const fallbackAlt = post?.excerpt || post?.title || '';

    // Apply fallback alt text to any image that lacks one.
    body.querySelectorAll('img').forEach((img) => {
      if (!img.getAttribute('alt')) img.setAttribute('alt', fallbackAlt);
    });

    if (onEnterImmersive) {
      const images = Array.from(body.querySelectorAll('img')).filter(
        (img) => !img.closest('a[href]')
      );
      images.forEach((img, i) => {
        img.classList.add('zoomable');
        img.setAttribute('tabindex', '0');
        const enter = () => onEnterImmersive(i);
        img.addEventListener('click', enter);
        img.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(); }
        });
      });
    }
    body.querySelectorAll('audio, video').forEach((el) => el.setAttribute('controls', ''));

    // EXIF overlays — normal mode only, when visibility allows and post has media
    if (this._exifVisible() && post?.media?.length) {
      const mediaMap = {};
      for (const m of post.media) {
        if (m.path) mediaMap[m.path] = m;
      }

      body.querySelectorAll('img').forEach((img) => {
        let src = img.src || '';
        try { src = new URL(src).pathname; } catch { /* already relative */ }
        src = src.replace(/\?(?:thumb)$/, '');
        const media = mediaMap[src];
        if (!media || !media.metadata || !Object.keys(media.metadata).length) return;

        const figure = document.createElement('figure');
        figure.className = 'media-exif-wrapper';
        img.parentNode.insertBefore(figure, img);
        figure.appendChild(img);

        const btn = document.createElement('button');
        btn.className = 'exif-info-btn';
        btn.setAttribute('aria-label', 'Show EXIF data');
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '\u2139';
        figure.appendChild(btn);

        const overlay = document.createElement('div');
        overlay.className = 'exif-overlay';
        overlay.setAttribute('role', 'complementary');
        overlay.setAttribute('aria-label', 'EXIF data');
        const title = document.createElement('div');
        title.className = 'exif-overlay-title';
        title.textContent = 'Camera data';
        overlay.appendChild(title);
        const table = document.createElement('table');
        const tbody = document.createElement('tbody');
        Object.entries(media.metadata).forEach(([k, v]) => {
          const tr = document.createElement('tr');
          const tdKey = document.createElement('td');
          tdKey.textContent = String(k);
          const tdVal = document.createElement('td');
          tdVal.textContent = String(v);
          tr.appendChild(tdKey);
          tr.appendChild(tdVal);
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        overlay.appendChild(table);
        figure.appendChild(overlay);

        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isVisible = overlay.classList.toggle('is-visible');
          btn.classList.toggle('is-active', isVisible);
          btn.setAttribute('aria-expanded', String(isVisible));
        });
      });
    }
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
