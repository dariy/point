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
import { escapeHtml, safeUrl, sharePost, navigate } from '../../utils/helpers.js';
import { SHARE_SVG } from '../../utils/icons.js';
import { store } from '../../store.js';
import { GestureController, TrackpadDetector, rubberBand } from '../../utils/gestures.js';
import { hideFlyout } from '../../utils/tags.js';
import { ViewContext } from '../../utils/viewContext.js';
import { getPostBySlug, getPostNavigation } from '../../api/posts.js';
import { mediaFromHtml } from '../../utils/postMedia.js';
import { exifVisible, buildExifMap, metadataForSrc, createImmersiveExifControl } from '../../utils/exif.js';

const MIN_SHOW_MS = 2000;

// Set just before a seamless cross-post navigation so the next MediaViewer
// mount skips its entrance fade — the dragged photo is already in place, so a
// fade-in would re-blink it. Lives at module scope to bridge the route swap.
let _suppressNextFadeIn = false;

export class MediaViewer extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._index = props.startIndex || 0;
    this._zoomState = { scale: 1, x: 0, y: 0 };
    this._listeners = [];
    this._lastShowTime = 0;
    // Cross-post peek: preloaded media of the adjacent posts, keyed by carousel
    // direction ('back' = step below index 0, 'fwd' = step past the last index).
    this._edge = { back: null, fwd: null };   // { slug, items, index, item }
    this._ghost = { back: null, fwd: null };   // ghost slide DOM element (images only)
    this._peekEl = null;                       // neighbor element currently being dragged into view
    this._peekDir = null;
    this._neighborVersion = 0;                 // guards stale async preloads
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
    const back = feedMode ? prev : next;
    const fwd = feedMode ? next : prev;
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
    this._slides = slides;
    this._dots = dots;

    const { items = [], media = [], onStep, onClose } = this.props;

    // EXIF info control — a single button + overlay at the viewer level (like
    // the share button, so it sits above the site header instead of being
    // swallowed by it). Per-slide metadata is resolved up front and the control
    // re-points to the active slide via _updateExif() on every step.
    const settings = store.get('settings') || {};
    this._exifMeta = null;
    if (exifVisible(settings, store.get('user')) && media.length) {
      const exifMap = buildExifMap(media);
      const meta = items.map((it) =>
        it.type === 'image' && it.url ? metadataForSrc(exifMap, it.url) : null,
      );
      if (meta.some(Boolean)) {
        this._exifMeta = meta;
        this._exifControl = createImmersiveExifControl();
        wrapper.append(this._exifControl.btn, this._exifControl.overlay);
        this._updateExif();
      }
    }

    const goTo = (i) => {
      const n = slides.length;
      if (!n) {
        if (i < 0) this._navigatePost('back');
        else if (i > 0) this._navigatePost('fwd');
        return;
      }
      
      const newIndex = ((i % n) + n) % n;
      
      // Post crossing — also crosses for single-media posts (n === 1),
      // where stepping off either edge wraps back to the same slide.
      if (i < 0 && newIndex === n - 1) {
        if (this._navigatePost('back')) return;
      }
      if (i >= n && newIndex === 0) {
        if (this._navigatePost('fwd')) return;
      }

      if (this._index === newIndex) return;

      const oldSlide = slides[this._index];
      const newSlide = slides[newIndex];
      this._index = newIndex;

      this._clearPeek();
      if (oldSlide) {
        oldSlide.querySelector('video')?.pause();
        oldSlide.classList.remove('active', 'immersive-fade-in');
        oldSlide.style.cssText = '';
      }
      if (newSlide) {
        newSlide.classList.add('active', 'immersive-fade-in');
        // Clear any leftover drag/peek inline styling so the slide lands centered.
        newSlide.style.transition = ''; newSlide.style.transform = '';
        newSlide.style.opacity = ''; newSlide.style.zIndex = '';
        newSlide.querySelector('video')?.play().catch(() => {});
      }

      dots.forEach((d, j) => d.classList.toggle('active', j === this._index));
      this._resetZoom();
      this._updateExif();
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

    // Fade in — unless we arrived via a seamless cross-post drag, where the
    // photo is already settled in place and a fade would re-blink it.
    if (_suppressNextFadeIn) {
      _suppressNextFadeIn = false;
    } else {
      (slides[this._index] || visuals).classList.add('immersive-fade-in');
    }

    // Gestures
    this._gesture = new GestureController(wrapper, {
      onSwipeMove: (dx, dy) => this._updateVisuals(this._calcSwipeX(dx), dy),
      onSwipeCancel: () => this._zoomState.scale > 1 ? this._constrainZoom(true) : this._resetVisuals(),
      onSwipeCommit: (dir) => {
        if (dir === 'down') return onClose?.();
        if (dir === 'up') return this._resetVisuals();
        if ((dir === 'left' && this._isBlocked('fwd')) || (dir === 'right' && this._isBlocked('back'))) {
          return this._resetVisuals();
        }
        this._commitHorizontal(dir === 'left' ? 'fwd' : 'back');
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

    // Preload the adjacent posts' edge media so they can peek in during a drag.
    this._preloadNeighbors();
  }

  /**
   * Resolve the post that lives just beyond a carousel edge.
   * 'back' = stepping below index 0; 'fwd' = stepping past the last index.
   * The feed-direction setting swaps which adjacent post sits on each side.
   */
  _targetFor(dir) {
    const settings = store.get('settings') || {};
    const feedMode = settings.immersive_nav_direction === 'feed';
    if (dir === 'back') return feedMode ? this.props.navPrev : this.props.navNext;
    return feedMode ? this.props.navNext : this.props.navPrev;
  }

  /**
   * Fetch the adjacent posts and build a hidden "ghost" slide for the image the
   * carousel will land on when crossing that edge (last image when stepping
   * back, first image when stepping forward). Images only — videos/text fall
   * back to the plain fade.
   */
  async _preloadNeighbors() {
    const version = ++this._neighborVersion;
    const load = async (dir) => {
      const target = this._targetFor(dir);
      if (!target?.slug) return;
      let post;
      try {
        post = await getPostBySlug(target.slug);
      } catch {
        return;
      }
      if (version !== this._neighborVersion) return;
      // Warm the navigation cache too, so crossing into this post reloads
      // without a spinner (both reads resolve from cache before paint).
      getPostNavigation(post.id).catch(() => {});
      const items = mediaFromHtml(post.content_html || '');
      if (!items.length) return;
      const index = dir === 'back' ? items.length - 1 : 0;
      const item = items[index];
      this._edge[dir] = { slug: target.slug, items, index, item };
      if (item && item.type === 'image') {
        new Image().src = safeUrl(item.url);     // warm the browser cache
        this._buildEdgeGhost(dir, item);
      }
    };
    await Promise.all([load('back'), load('fwd')]);
  }

  /** Create the off-screen ghost slide element for a cross-post peek. */
  _buildEdgeGhost(dir, item) {
    const visuals = this.$('.immersive-visuals');
    if (!visuals || this._ghost[dir]) return;
    const el = document.createElement('div');
    el.className = 'carousel-slide edge-ghost';
    el.dataset.edge = dir;
    el.innerHTML = this._renderItem(item);
    el.style.opacity = '0';
    visuals.appendChild(el);
    this._ghost[dir] = el;
  }

  /**
   * Cross into the adjacent post.
   * @param {'back'|'fwd'} dir
   * @param {{ seamless?: boolean }} [opts]  seamless=true skips the fade-out and
   *   suppresses the next entrance fade, for an uninterrupted drag hand-off
   *   (the adjacent post + its nav are already cached, so the reload paints
   *   nothing). seamless=false keeps the classic fade for keyboard/click nav.
   */
  _navigatePost(dir, { seamless = false } = {}) {
    const target = this._targetFor(dir);
    if (!target) return false;

    // Land on the post's last image when stepping back, its first when
    // stepping forward — so a multi-image post read backwards shows its last
    // photo first, then the one before it, like a continuous stripe.
    let startIndex = 0;
    if (dir === 'back') {
      const edge = this._edge.back;
      startIndex = edge?.items?.length ? edge.items.length - 1 : 0;
    }

    const go = () => {
      const ctx = ViewContext.current();
      ctx.postSlug = target.slug;
      let url = ctx.toUrl();
      if (startIndex > 0) url += `#${startIndex + 1}`;
      navigate(url);
    };

    if (seamless && this._ghost[dir]) {
      _suppressNextFadeIn = true;
      go();
    } else {
      this.$('.immersive-visuals')?.classList.add('immersive-fade-out');
      setTimeout(go, 300);
    }
    return true;
  }

  _isBlocked(dir) {
    const n = this.props.items.length;
    const isAtEdge = dir === 'back' ? this._index === 0 : this._index === n - 1;
    if (!isAtEdge) return false;
    return !this._targetFor(dir);
  }

  /**
   * The element that should peek in from the opposite edge during a drag in the
   * given direction: the adjacent in-post slide, or the preloaded cross-post
   * ghost when at a post boundary. Null when there's nothing to reveal.
   */
  _neighborEl(dir) {
    const n = this.props.items.length;
    const idx = dir === 'fwd' ? this._index + 1 : this._index - 1;
    if (idx >= 0 && idx < n) return this._slides?.[idx] || null;
    return this._ghost[dir];
  }

  /**
   * Carry the committed swipe to rest — the active slide finishes sliding off
   * and its neighbor finishes sliding to centre, continuing the drag's motion.
   * When the neighbor belongs to the next/prev post, the route swaps under it
   * once it lands, so the photo movement flows unbroken across the boundary.
   */
  _commitHorizontal(dir) {
    const newIndex = dir === 'fwd' ? this._index + 1 : this._index - 1;
    const n = this.props.items.length;
    const crossing = newIndex < 0 || newIndex >= n;
    const neighbor = this._neighborEl(dir);

    // Crossing to a post with no previewable edge image (video/text, or not yet
    // preloaded): nothing to slide in, so use the plain fade instead of sliding
    // the current photo off to an empty screen.
    if (crossing && !neighbor) {
      this._resetVisuals();
      this._navigatePost(dir);
      return;
    }

    const W = window.innerWidth;
    const active = this._slides[this._index];
    const T = 'transform 0.28s ease-out, opacity 0.28s ease-out';

    if (active) {
      active.style.transition = T;
      active.style.transform = `translateX(${dir === 'fwd' ? -W : W}px)`;
      active.style.opacity = '0';
    }
    if (neighbor) {
      neighbor.style.transition = T;
      neighbor.style.transform = 'translateX(0)';
      neighbor.style.opacity = '1';
      neighbor.style.zIndex = '11';
    }

    setTimeout(() => {
      if (crossing) this._navigatePost(dir, { seamless: true });
      else this._finalizeSwap(newIndex);
    }, 280);
  }

  /**
   * Make `newIndex` the active slide without a crossfade — the drag animation
   * has already moved it into place, so we just swap classes and clean up.
   */
  _finalizeSwap(newIndex) {
    const old = this._slides[this._index];
    const next = this._slides[newIndex];
    this._index = newIndex;
    this._peekEl = null; this._peekDir = null;
    if (old) {
      old.querySelector('video')?.pause();
      old.classList.remove('active', 'immersive-fade-in');
      old.style.cssText = '';
    }
    if (next) {
      next.classList.add('active');
      next.style.transition = ''; next.style.transform = '';
      next.style.opacity = ''; next.style.zIndex = '';
      next.querySelector('video')?.play().catch(() => {});
    }
    this._dots.forEach((d, j) => d.classList.toggle('active', j === this._index));
    this._resetZoom();
    this.props.onStep?.(this._index);
  }

  /** Track the element currently peeking in, clearing any previous one. */
  _setPeek(dir, el) {
    if (this._peekEl && this._peekEl !== el) this._clearPeek();
    this._peekEl = el;
    this._peekDir = dir;
  }

  /** Instantly reset the peeking neighbor back to its hidden base state. */
  _clearPeek() {
    const el = this._peekEl;
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform = '';
    el.style.opacity = '';
    el.style.zIndex = '';
    this._peekEl = null;
    this._peekDir = null;
  }

  /** Animate the peeking neighbor back off-screen, then clear it. */
  _settlePeek() {
    const el = this._peekEl;
    const dir = this._peekDir;
    if (!el) return;
    const W = window.innerWidth;
    el.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
    el.style.transform = `translateX(${dir === 'fwd' ? W : -W}px)`;
    el.style.opacity = '0';
    setTimeout(() => this._clearPeek(), 300);
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

  _activeEl() {
    return this._slides?.[this._index] || this.$('.carousel-slide.active') || this.$('.immersive-visuals');
  }

  _resetVisuals() {
    const target = this._activeEl();
    if (target) {
      target.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      target.style.transform = ''; target.style.opacity = '1';
    }
    this._settlePeek();
  }

  _updateVisuals(dx = 0, dy = 0) {
    const { scale, x, y } = this._zoomState;
    const tx = x + dx; const ty = y + dy;
    const target = this._activeEl();
    if (!target) return;
    if (scale === 1) {
      if (Math.abs(tx) > Math.abs(ty)) {
        this._horizontalDrag(target, tx);
        return;
      }
      this._clearPeek();
      if (ty > 0) {
        const s = Math.max(0.5, 1 - ty / window.innerHeight);
        target.style.transform = `translateY(${ty}px) scale(${s})`;
        target.style.opacity = s;
      } else {
        target.style.transform = ''; target.style.opacity = '1';
      }
    } else {
      this._clearPeek();
      target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      target.style.opacity = '1';
    }
    target.style.transition = 'none';
  }

  /**
   * Horizontal drag at 1× zoom: translate the active slide and fade it toward
   * the edge, while sliding the neighbor in from the opposite side with the
   * mirrored (rising) opacity — the "infinite stripe" feel.
   */
  _horizontalDrag(active, tx) {
    const W = window.innerWidth;
    const dir = tx < 0 ? 'fwd' : 'back';
    const neighbor = this._neighborEl(dir);
    const ratio = Math.min(1, Math.abs(tx) / W);
    active.style.transition = 'none';
    active.style.transform = `translateX(${tx}px)`;
    // With a neighbor revealed, fade the outgoing slide fully out; otherwise
    // keep a floor so a blocked/edge drag never blanks the screen.
    active.style.opacity = String(neighbor ? Math.max(0, 1 - ratio) : Math.max(0.3, 1 - ratio));
    if (!neighbor) { this._clearPeek(); return; }
    this._setPeek(dir, neighbor);
    const offset = dir === 'fwd' ? W : -W;
    neighbor.style.transition = 'none';
    neighbor.style.transform = `translateX(${offset + tx}px)`;
    neighbor.style.opacity = String(ratio);
    neighbor.style.zIndex = '11';
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
  /** Point the EXIF control at the active slide (no-op when no EXIF present). */
  _updateExif() {
    if (!this._exifControl || !this._exifMeta) return;
    this._exifControl.setMetadata(this._exifMeta[this._index] || null);
  }

  _cleanup() {
    this._listeners.forEach(([t, e, s, i]) => t.removeEventListener(e, s, i));
    this._listeners = []; this._gesture?.destroy(); this._trackpad?.destroy();
    // The EXIF control lives inside the re-rendered wrapper; drop our reference
    // so a stale control isn't reused after the next render.
    this._exifControl = null;
    this._exifMeta = null;
    // Invalidate any in-flight neighbor preload and drop peek references; the
    // ghost elements live inside the re-rendered visuals and are discarded with it.
    this._neighborVersion++;
    this._edge = { back: null, fwd: null };
    this._ghost = { back: null, fwd: null };
    this._peekEl = null;
    this._peekDir = null;
  }
}
