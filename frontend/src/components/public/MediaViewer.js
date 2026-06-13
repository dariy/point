/**
 * MediaViewer — Unified carousel component for immersive posts and lightbox.
 * (point-x52z.19)
 *
 * Handles:
 *   - Swipe, pinch-zoom, pan gestures
 *   - Keyboard navigation
 *   - UI auto-hide
 *   - Slide progress indicators
 *   - Full-screen post-to-post navigation
 *
 * Props:
 *   items      {Array<{ type, url, alt, html }>}
 *   startIndex {number}
 *   showClose  {boolean}
 *   showShare  {boolean}
 *   onClose    {function}
 *   onStep     {function(index)}
 *   navPrev    {object|null}  { slug, title }
 *   navNext    {object|null}  { slug, title }
 */

import { Component } from '../Component.js';
import { escapeHtml, safeUrl, sharePost } from '../../utils/helpers.js';
import { SHARE_SVG } from '../../utils/icons.js';
import { store } from '../../store.js';
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';
import { hideFlyout } from '../../utils/tags.js';

const MIN_SHOW_MS = 2000;

export class MediaViewer extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._index = props.startIndex || 0;
    this._zoomState = { scale: 1, x: 0, y: 0 };
    this._listeners = [];
    this._lastShowTime = 0;
  }

  render() {
    const { items = [], showClose = false, showShare = true, navPrev, navNext } = this.props;
    if (!items.length) return '';

    const slides = items.map((item, i) => `
      <div class="carousel-slide${i === this._index ? ' active' : ''}" data-index="${i}">
        ${this._renderItem(item)}
      </div>
    `).join('');

    const dots = items.map((_, i) => `
      <button class="carousel-dot${i === this._index ? ' active' : ''}"
              data-index="${i}" aria-label="Media ${i + 1} of ${items.length}"></button>
    `).join('');

    const closeBtn = showClose ? `<button class="lightbox-close" aria-label="Close">×</button>` : '';
    const shareBtn = showShare ? `
      <button class="header-action-btn share-btn carousel-share-btn" type="button" aria-label="Share">
        ${SHARE_SVG}
      </button>` : '';

    // If single item, show post nav arrows if provided
    const showPostNav = items.length === 1 && (navPrev || navNext);
    const postNav = showPostNav ? this._renderPostNav(navPrev, navNext) : '';

    return `
      <div class="media-viewer-wrapper">
        <div class="immersive-visuals" id="media-viewer-visuals">
          ${slides}
        </div>
        ${closeBtn}
        ${shareBtn}
        ${items.length > 1 ? `
          <div class="immersive-nav-panel immersive-nav-prev" aria-label="Previous"><div class="immersive-nav-gradient"></div></div>
          <div class="immersive-nav-panel immersive-nav-next" aria-label="Next"><div class="immersive-nav-gradient"></div></div>
          <div class="carousel-indicators">${dots}</div>
        ` : postNav}
      </div>`;
  }

  _renderItem(item) {
    if (item.type === 'html') {
      return `<div class="immersive-text-slide"><div class="immersive-text-content">${item.html}</div></div>`;
    }
    const url = safeUrl(item.url);
    if (item.type === 'video') {
      return `<video src="${url}" class="immersive-bg-image" autoplay muted loop playsinline></video>`;
    }
    if (item.type === 'audio') {
      return `<div class="immersive-audio-container"><audio src="${url}" class="immersive-audio-player" controls></audio></div>`;
    }
    return `<img src="${url}" alt="${escapeHtml(item.alt || '')}" class="immersive-bg-image" loading="lazy">`;
  }

  _renderPostNav(prev, next) {
    const settings = store.get('settings') || {};
    const feedMode = settings.immersive_nav_direction === 'feed';
    const back = feedMode ? next : prev;
    const fwd = feedMode ? prev : next;
    const prevHtml = back ? `<div class="immersive-nav-panel immersive-nav-prev" data-nav="back"><div class="immersive-nav-gradient"></div></div>` : '';
    const nextHtml = fwd ? `<div class="immersive-nav-panel immersive-nav-next" data-nav="fwd"><div class="immersive-nav-gradient"></div></div>` : '';
    return prevHtml + nextHtml;
  }

  afterRender() {
    this._initInteractivity();
  }

  beforeUnmount() {
    this._cleanup();
  }

  _initInteractivity() {
    this._cleanup();
    const wrapper = this.$('.media-viewer-wrapper');
    const visuals = this.$('.immersive-visuals');
    const slides = Array.from(visuals.querySelectorAll('.carousel-slide'));
    const dots = Array.from(this.container.querySelectorAll('.carousel-dot'));

    const { items = [], onStep, onClose } = this.props;

    const goTo = (i) => {
      const n = slides.length;
      if (!n) {
        if (i < 0) this._navigatePost('back');
        else if (i > 0) this._navigatePost('fwd');
        return;
      }
      
      const newIndex = ((i % n) + n) % n;
      
      // Post crossing
      if (i < 0 && newIndex === n - 1 && n > 1) {
        if (this._navigatePost('back')) return;
      }
      if (i >= n && newIndex === 0 && n > 1) {
        if (this._navigatePost('fwd')) return;
      }

      if (this._index === newIndex) return;

      const oldSlide = slides[this._index];
      const newSlide = slides[newIndex];
      this._index = newIndex;

      if (oldSlide) {
        oldSlide.querySelector('video')?.pause();
        oldSlide.classList.remove('active', 'immersive-fade-in');
        oldSlide.style.transform = ''; oldSlide.style.opacity = '';
      }
      if (newSlide) {
        newSlide.classList.add('active', 'immersive-fade-in');
        newSlide.querySelector('video')?.play().catch(() => {});
      }

      dots.forEach((d, j) => d.classList.toggle('active', j === this._index));
      this._resetZoom();
      onStep?.(this._index);
    };

    // Nav panels
    this._on(this.$('.immersive-nav-prev'), 'click', (e) => this._panelClick(e, () => goTo(this._index - 1)));
    this._on(this.$('.immersive-nav-next'), 'click', (e) => this._panelClick(e, () => goTo(this._index + 1)));
    dots.forEach((d, i) => this._on(d, 'click', () => goTo(i)));

    // Close
    this._on(this.$('.lightbox-close'), 'click', () => onClose?.());
    this._on(wrapper, 'click', (e) => {
        if (e.target === wrapper || e.target === visuals) onClose?.();
    });

    // Share
    this._on(this.$('.carousel-share-btn'), 'click', (e) => {
      e.stopPropagation();
      sharePost({ title: document.title, url: window.location.href });
    });

    // Fade in
    (slides[this._index] || visuals).classList.add('immersive-fade-in');

    // Gestures
    this._gesture = new GestureController(wrapper, {
      onSwipeMove: (dx, dy) => this._updateVisuals(this._calcSwipeX(dx), dy),
      onSwipeCancel: () => this._zoomState.scale > 1 ? this._constrainZoom(true) : this._resetVisuals(),
      onSwipeCommit: (dir) => {
        if ((dir === 'left' && this._isBlocked('fwd')) || (dir === 'right' && this._isBlocked('back'))) {
          return this._resetVisuals();
        }
        if (dir === 'left') goTo(this._index + 1);
        else if (dir === 'right') goTo(this._index - 1);
        else if (dir === 'down') onClose?.();
        else this._updateVisuals();
      },
      onPanMove: (dx, dy) => {
        this._zoomState.x += dx;
        this._zoomState.y += dy;
        this._updateVisuals();
      },
      onPinchMove: (delta, cx, cy) => {
        const oldScale = this._zoomState.scale;
        const newScale = Math.max(0.5, Math.min(this._getMaxScale() * 2, oldScale * delta));
        if (newScale === oldScale) return;
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
      onPinchEnd: () => this._constrainZoom(true),
      onTap: (x, y) => {
        const tapped = document.elementFromPoint(x, y);
        if (tapped?.closest('a, button, .immersive-nav-panel, input, .post-info-card')) return;
        document.body.classList.contains('ui-hidden') ? this._showUI() : this._hideUI();
      },
      onDoubleTap: (x, y) => {
        if (this._zoomState.scale > 1) return this._resetZoom();
        const max = this._getMaxScale();
        if (max <= 1) return;
        const rect = wrapper.getBoundingClientRect();
        this._zoomState.scale = max;
        this._zoomState.x = (rect.width / 2 - (x - rect.left)) * (max - 1);
        this._zoomState.y = (rect.height / 2 - (y - rect.top)) * (max - 1);
        this._gesture.setZoomed(true);
        wrapper.classList.add('zoomed');
        this._updateVisuals();
      }
    });

    this._trackpad = new TrackpadDetector(wrapper, {
      onHorizontal: (dir) => goTo(this._index + (dir === 'left' ? 1 : -1))
    });

    // Keyboard
    this._on(document, 'keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (this._zoomState.scale > 1) {
        if (e.key === 'Escape') this._resetZoom();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goTo(this._index - 1); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goTo(this._index + 1); }
      else if (e.key === 'Escape' || e.key === 'ArrowDown') { e.preventDefault(); onClose?.(); }
      else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
      else if (e.key === 'End') { e.preventDefault(); goTo(items.length - 1); }
      else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        document.body.classList.contains('ui-hidden') ? this._showUI() : (Date.now() - this._lastShowTime >= MIN_SHOW_MS && this._hideUI());
      }
    });

    this._lastShowTime = Date.now();
  }

  _navigatePost(dir) {
    const settings = store.get('settings') || {};
    const feedMode = settings.immersive_nav_direction === 'feed';
    const target = dir === 'back' ? (feedMode ? this.props.navNext : this.props.navPrev) : (feedMode ? this.props.navPrev : this.props.navNext);
    if (!target) return false;
    
    const visuals = this.$('.immersive-visuals');
    visuals.classList.add('immersive-fade-out');
    setTimeout(() => {
        import('../../utils/viewContext.js').then(m => {
            m.ViewContext.update({ postSlug: target.slug });
        });
    }, 400);
    return true;
  }

  _isBlocked(dir) {
    const n = this.props.items.length;
    const isAtEdge = dir === 'back' ? this._index === 0 : this._index === n - 1;
    if (!isAtEdge) return false;
    const settings = store.get('settings') || {};
    const feedMode = settings.immersive_nav_direction === 'feed';
    const target = dir === 'back' ? (feedMode ? this.props.navNext : this.props.navPrev) : (feedMode ? this.props.navPrev : this.props.navNext);
    return !target;
  }

  _calcSwipeX(dx) {
    if (Math.abs(dx) <= Math.abs(this._lastDy || 0)) return dx;
    const blocked = (dx > 0 && this._isBlocked('back')) || (dx < 0 && this._isBlocked('fwd'));
    return blocked ? rubberBand(dx) : dx;
  }

  _resetZoom() {
    this._zoomState = { scale: 1, x: 0, y: 0 };
    this._updateVisuals();
    this._gesture?.setZoomed(false);
    this.$('.media-viewer-wrapper').classList.remove('zoomed');
  }

  _resetVisuals() {
    const target = this.$('.carousel-slide.active') || this.$('.immersive-visuals');
    if (target) {
      target.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      target.style.transform = ''; target.style.opacity = '1';
    }
  }

  _updateVisuals(dx = 0, dy = 0) {
    const { scale, x, y } = this._zoomState;
    const tx = x + dx; const ty = y + dy;
    const target = this.$('.carousel-slide.active') || this.$('.immersive-visuals');
    if (!target) return;
    if (scale === 1) {
      if (Math.abs(tx) > Math.abs(ty)) {
        target.style.transform = `translateX(${tx}px)`;
        target.style.opacity = Math.max(0.3, 1 - Math.abs(tx) / window.innerWidth);
      } else if (ty > 0) {
        const s = Math.max(0.5, 1 - ty / window.innerHeight);
        target.style.transform = `translateY(${ty}px) scale(${s})`;
        target.style.opacity = s;
      }
    } else {
      target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      target.style.opacity = '1';
    }
    target.style.transition = 'none';
  }

  _getMaxScale() {
    const img = (this.$('.carousel-slide.active') || this.$('.immersive-visuals')).querySelector('img, video');
    if (!img) return 2;
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth || img.videoWidth || rect.width * 2;
    return Math.max(window.innerWidth / rect.width, window.innerHeight / rect.height, nw / rect.width, 2);
  }

  _panelClick(e, navFn) {
    const panel = e.currentTarget; panel.style.pointerEvents = 'none';
    const link = document.elementFromPoint(e.clientX, e.clientY)?.closest('a');
    panel.style.pointerEvents = '';
    if (link) link.click(); else { e.stopPropagation(); navFn(); }
  }

  _showUI() { document.body.classList.remove('ui-hidden'); this._lastShowTime = Date.now(); }
  _hideUI() { hideFlyout(); document.body.classList.add('ui-hidden'); }

  _on(t, e, s, i) { if (t) { t.addEventListener(e, s, i); this._listeners.push([t, e, s, i]); } }
  _cleanup() {
    this._listeners.forEach(([t, e, s, i]) => t.removeEventListener(e, s, i));
    this._listeners = []; this._gesture?.destroy(); this._trackpad?.destroy();
  }
}
