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

import { Component } from "../Component.js";
import { escapeHtml, safeUrl, navigate } from "../../utils/helpers.js";
import { COPY_SVG, CHECK_SVG, SHARE_SVG } from "../../utils/icons.js";
import {
  buildTagIndex,
  renderTagStrip,
  setupTagStrip,
  hideFlyout,
} from "../../utils/tags.js";
import { store } from "../../store.js";
import {
  GestureController,
  TrackpadDetector,
  rubberBand,
} from "../../utils/gestures.js";
import { getPostPageLocation } from "../../api/posts.js";
import { ViewContext } from "../../utils/viewContext.js";
import { sharePost } from "../../utils/helpers.js";

const _prismLoading = new Map();
const _LANG_DEPS = {
  javascript: ["clike"],
  typescript: ["clike", "javascript"],
  go: ["clike"],
  c: ["clike"],
  cpp: ["clike", "c"],
  java: ["clike"],
  ruby: ["clike"],
};

async function _ensurePrismCore() {
  if (window.Prism) return;
  await import("/assets/vendor/prismjs/prism-core.js");
}

async function _loadPrismLang(lang) {
  if (_prismLoading.has(lang)) return _prismLoading.get(lang);
  const p = (async () => {
    for (const dep of _LANG_DEPS[lang] ?? []) await _loadPrismLang(dep);
    if (!window.Prism?.languages[lang]) {
      await import(`/assets/vendor/prismjs/prism-${lang}.js`);
    }
  })();
  _prismLoading.set(lang, p);
  return p;
}

const MIN_SHOW_MS = 2000; // UI must be visible ≥ 2 s before click-to-hide works
let _overlayHidden = false; // persists across post navigations

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogv", "m4v", "avi", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "ogg", "wav", "flac", "aac", "opus"]);
const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
  "heic",
  "heif",
  "bmp",
]);

/** Return 'video', 'audio', 'image', or null based on file extension. */
function mediaTypeFromPath(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return null;
}

function stripHtml(html) {
  if (!html) return "";
  let previous;
  do {
    previous = html;
    html = html.replace(/<[^>]*>/g, "");
  } while (html !== previous);
  return html;
}

/**
 * Returns true when the post should render in immersive (full-screen) mode.
 * Exported so PostPage can use the same check to configure its child components.
 */
export function shouldUseImmersive(post) {
  if (!post) return false;

  // Explicit override from editor takes precedence over auto-detection.
  if (post.immersive_mode === "immersive") return true;
  if (post.immersive_mode === "non-immersive") return false;

  const html = post.content_html || "";
  if (
    html.includes("<hr>") ||
    html.includes("<hr/>") ||
    html.includes("<hr />")
  )
    return true;

  // Pages only go immersive when explicitly separated with ---; skip media fallback.
  if (post.type === "page" || post.status === "page") return false;

  const media = post.media || [];
  // Audio-only attachment posts stay in normal layout
  if (media.length && media.every((m) => m.type === "audio")) return false;

  // Strip all HTML tags; what remains is the visible text.
  const text = stripHtml(html).replace(/&nbsp;/g, " ").trim();

  // If there is text, check whether every non-empty line is a bare media path.
  // If so it counts as media, not prose.
  if (text.length !== 0) {
    const lines = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const allMedia = lines.every(
      (l) => /^(?:https?:\/\/|\/)\S+$/.test(l) && mediaTypeFromPath(l),
    );
    if (!allMedia) return false;
  }

  const hasVisualMedia = media.some((m) => m.type !== "audio");
  const hasContentMedia = html.trim().length > 0;
  return hasVisualMedia || hasContentMedia;
}

export class PostContent extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._lastShowTime = 0;
    this._listeners = []; // [target, type, fn, opts]
    this._zoomState = { scale: 1, x: 0, y: 0 };
  }

  render() {
    const {
      post,
      prevPost = null,
      nextPost = null,
      forceImmersive = false,
    } = this.props;
    if (!post) return "";
    return forceImmersive || shouldUseImmersive(post)
      ? this._renderImmersive(post, prevPost, nextPost)
      : this._renderNormal(post, prevPost, nextPost);
  }

  afterRender() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
    const {
      post,
      prevPost = null,
      nextPost = null,
      forceImmersive = false,
    } = this.props;
    if (!post) return;
    if (forceImmersive || shouldUseImmersive(post)) {
      document.body.classList.add("immersive-layout");
      this._initImmersive();
    } else {
      document.body.classList.remove("immersive-layout", "ui-hidden");
      const bodyEl = this.$(".post-content");
      if (bodyEl) {
        this._enhanceLinks(bodyEl);
        this._enhanceMedia(bodyEl);
        this._enhanceCodeBlocks(bodyEl);
      }
      if (prevPost || nextPost) this._initNormal(prevPost, nextPost);

      this._cleanupStrip?.();
      if (!this._subscribed) {
        this.subscribeStore(store, "navTags", () => this._rerender());
        this._subscribed = true;
      }

      const footer = this.$(".post-footer");
      if (footer) {
        const navTags = store.get("navTags") || [];
        const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
        this._cleanupStrip = setupTagStrip(footer, tagIndex, (url) => {
          const slug = url.replace('/tags/', '');
          ViewContext.update({ tag: slug, postSlug: null, query: null });
        });
      }
    }
  }

  beforeRender() {
    _overlayHidden = document.body.classList.contains("ui-hidden");
    this._listeners.forEach(([t, type, fn, opts]) =>
      t.removeEventListener(type, fn, opts),
    );
    this._listeners = [];
    this._gesture?.destroy();
    this._gesture = null;
    this._trackpad?.destroy();
    this._trackpad = null;
    this._cleanupStrip?.();
    this._cleanupStrip = null;
  }

  beforeUnmount() {
    this.beforeRender();
    // Body classes are kept intentionally — the next page's afterRender handles cleanup.
    // Keeping them prevents the overlay blink when navigating between immersive posts.
  }

  // ── Immersive rendering ───────────────────────────────────────────────────

  _exifVisible() {
    const settings = store.get("settings") || {};
    const v = settings.exif_visibility || "hide";
    if (v === "hide") return false;
    if (v === "admin" && !store.get("user")) return false;
    return true;
  }

  _renderExifTable(metadata) {
    const entries = Object.entries(metadata || {});
    if (!entries.length) return "";
    const rows = entries
      .map(
        ([k, v]) =>
          `<tr><td>${escapeHtml(String(k))}</td><td>${escapeHtml(String(v))}</td></tr>`,
      )
      .join("");
    return `<table><tbody>${rows}</tbody></table>`;
  }

  _renderImmersive(post, prevPost, nextPost) {
    // Always derive carousel items from HTML — post.media has {path,metadata} shape for EXIF only
    const items = this._mediaFromHtml(post.content_html || "");
    const startIndex = Math.min(
      this.props.startIndex || 0,
      Math.max(0, items.length - 1),
    );
    const visuals =
      items.length === 1
        ? this._mediaEl(items[0])
        : this._renderCarousel(items, startIndex);

    // Single-image posts have no carousel arrows, so add post-navigation arrows.
    const postNavArrows =
      items.length === 1
        ? this._renderImmersivePostNav(prevPost, nextPost)
        : "";

    const showExcerpt = this.props.showImmersiveExcerpt !== false;
    const excerptHtml =
      showExcerpt && post.excerpt
        ? `<div class="post-excerpt-card">${escapeHtml(post.excerpt)}</div>`
        : "";

    const postCss = post.css ? `<style id="post-css">${post.css}</style>` : "";

    return `
      <div class="immersive-wrapper">
        ${postCss}<div class="immersive-visuals">${visuals}</div>
        <button class="header-action-btn share-btn carousel-share-btn" type="button" aria-label="Share">
          ${SHARE_SVG}
        </button>
        ${postNavArrows}
        ${excerptHtml}
      </div>`;
  }

  /** Render prev/next post arrow buttons for single-image immersive posts. */
  _renderImmersivePostNav(prevPost, nextPost) {
    if (!prevPost && !nextPost) return "";
    const settings = store.get("settings") || {};
    const feedMode = settings.immersive_nav_direction === "feed";
    const backPost = feedMode ? nextPost : prevPost;
    const fwdPost = feedMode ? prevPost : nextPost;
    const prev = backPost
      ? `<div class="immersive-nav-panel immersive-nav-prev" aria-label="Previous post"><div class="immersive-nav-gradient"></div></div>`
      : "";
    const next = fwdPost
      ? `<div class="immersive-nav-panel immersive-nav-next" aria-label="Next post"><div class="immersive-nav-gradient"></div></div>`
      : "";
    return prev + next;
  }

  _renderCarousel(media, startIndex = 0) {
    const slides = media
      .map(
        (item, i) => `
      <div class="carousel-slide${i === startIndex ? " active" : ""}" data-index="${i}">
        ${this._mediaEl(item)}
      </div>`,
      )
      .join("");

    const dots = media
      .map(
        (_, i) => `
      <button class="carousel-dot${i === startIndex ? " active" : ""}"
              data-index="${i}" aria-label="Media ${i + 1} of ${media.length}"></button>`,
      )
      .join("");

    return `
      <div class="carousel-container" id="immersive-carousel">
        ${slides}
        <button class="header-action-btn share-btn carousel-share-btn" type="button" aria-label="Share">
          ${SHARE_SVG}
        </button>
        <div class="immersive-nav-panel immersive-nav-prev" aria-label="Previous"><div class="immersive-nav-gradient"></div></div>
        <div class="immersive-nav-panel immersive-nav-next" aria-label="Next"><div class="immersive-nav-gradient"></div></div>
        <div class="carousel-indicators">${dots}</div>
      </div>`;
  }

  _mediaEl(item) {
    if (item.type === "html") {
      return `<div class="immersive-text-slide">
                <div class="immersive-text-content">${item.html}</div>
              </div>`;
    }
    const url = safeUrl(item.url);
    if (item.type === "video") {
      return `<video src="${url}" class="immersive-bg-image" autoplay muted loop playsinline></video>`;
    }
    if (item.type === "audio") {
      return `<div class="immersive-audio-container">
                <audio src="${url}" class="immersive-audio-player" controls></audio>
              </div>`;
    }
    return `<img src="${url}" alt="${escapeHtml(item.alt || "")}" class="immersive-bg-image" loading="lazy">`;
  }

  /** Extract image/video/audio items from HTML, including bare media paths in text. */
  _mediaFromHtml(html) {
    const items = [];

    // If there are page breaks, split by <hr> and treat each segment as a slide.
    if (
      html.includes("<hr>") ||
      html.includes("<hr/>") ||
      html.includes("<hr />")
    ) {
      const segments = html.split(/<hr\s*\/?>/i);
      for (const segment of segments) {
        const trimmed = segment.trim();
        if (!trimmed) continue;

        // Extract media from this segment to see if it's a bare media slide.
        const segmentMedia = this._extractMedia(trimmed);
        const text = stripHtml(trimmed).replace(/&nbsp;/g, " ").trim();

        if (
          segmentMedia.length === 1 &&
          (text.length === 0 || text === segmentMedia[0].url)
        ) {
          // Exactly one media element and no other prose: treat as a visual slide.
          items.push(segmentMedia[0]);
        } else {
          // Mixed content or pure text: treat as an HTML slide.
          items.push({ type: "html", html: trimmed });
        }
      }
      if (items.length > 0) return items;
    }

    return this._extractMedia(html);
  }

  /** Internal helper to extract all media items from a block of HTML. */
  _extractMedia(html) {
    const items = [];
    for (const m of html.matchAll(/<img[^>]+>/gi)) {
      const src = (m[0].match(/\ssrc="([^"]*)"/i) || [])[1] || "";
      const alt = (m[0].match(/\salt="([^"]*)"/i) || [])[1] || "";
      if (src) items.push({ type: "image", url: src, alt });
    }
    for (const m of html.matchAll(
      /<(?:video|source)[^>]*\ssrc="([^"]*)"[^>]*/gi,
    )) {
      if (m[1]) items.push({ type: "video", url: m[1] });
    }
    for (const m of html.matchAll(/<audio[^>]*\ssrc="([^"]*)"[^>]*/gi)) {
      if (m[1]) items.push({ type: "audio", url: m[1] });
    }
    // Fallback: bare media paths rendered as plain text by the markdown parser.
    if (items.length === 0) {
      const text = stripHtml(html).trim();
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
    const settings = store.get("settings") || {};
    const feedMode = settings.immersive_nav_direction === "feed";
    const backPost = feedMode ? nextPost : prevPost;
    const fwdPost = feedMode ? prevPost : nextPost;

    // ── Carousel helpers ──
    const carousel = this.$("#immersive-carousel");
    const slides = carousel
      ? Array.from(carousel.querySelectorAll(".carousel-slide"))
      : [];
    const dots = carousel
      ? Array.from(carousel.querySelectorAll(".carousel-dot"))
      : [];
    let index = Math.min(
      this.props.startIndex || 0,
      Math.max(0, slides.length - 1),
    );

    const goToPost = (p) => {
      if (!p) return;
      const target = slides[index] ?? visuals;
      if (target) {
        target.classList.remove("immersive-fade-in");
        target.classList.add("immersive-fade-out");
      }
      setTimeout(() => {
        ViewContext.update({ postSlug: p.slug });
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
        if (backPost) {
          goToPost(backPost);
          return;
        }
      }
      if (i >= n && newIndex === 0 && slides.length > 1) {
        if (fwdPost) {
          goToPost(fwdPost);
          return;
        }
      }

      const oldIndex = index;
      if (oldIndex === newIndex) return;

      // Update index immediately so gestures during transition reference the new slide.
      index = newIndex;

      // Update URL hash to reflect the current slide (e.g. index 1 -> #2)
      const hash = index === 0 ? "" : `#${index + 1}`;
      const url = window.location.pathname + window.location.search + hash;
      window.history.replaceState(null, "", url);

      const oldSlide = slides[oldIndex];
      const newSlide = slides[newIndex];

      // Hide old slide immediately to prevent it showing through the fading-in new slide.
      if (oldSlide) {
        oldSlide.querySelector("video")?.pause();
        oldSlide.classList.remove(
          "active",
          "immersive-fade-in",
          "immersive-fade-out",
        );
        // Clear inline styles set by _updateVisuals during swipe gestures.
        // Without this, style.transition='none' blocks the CSS fade-out and
        // style.opacity overrides CSS opacity:0, leaving the old slide visible.
        oldSlide.style.transform = "";
        oldSlide.style.opacity = "";
        oldSlide.style.transition = "";
      }

      // Activate and fade in the new slide.
      if (newSlide) {
        newSlide.classList.add("active", "immersive-fade-in");
        newSlide
          .querySelector("video")
          ?.play()
          .catch(() => {});
      }

      dots.forEach((d, j) => d.classList.toggle("active", j === index));
      this._resetZoom();
    };

    // If the click landed over a link hidden beneath the nav panel, follow it instead of navigating.
    const navClickOrLink = (e, navigate) => {
      const panel = e.currentTarget;
      panel.style.pointerEvents = "none";
      const underneath = document.elementFromPoint(e.clientX, e.clientY);
      panel.style.pointerEvents = "";
      const link = underneath?.closest("a");
      if (link) { link.click(); return; }
      e.stopPropagation();
      navigate();
    };

    if (carousel) {
      this._on(carousel.querySelector(".immersive-nav-prev"), "click", (e) => {
        navClickOrLink(e, () => goTo(index - 1));
      });
      this._on(carousel.querySelector(".immersive-nav-next"), "click", (e) => {
        navClickOrLink(e, () => goTo(index + 1));
      });
      dots.forEach((d, i) =>
        this._on(d, "click", (e) => {
          e.stopPropagation();
          goTo(i);
        }),
      );
    } else {
      // Single-image post — wire up post-navigation arrows rendered by _renderImmersivePostNav.
      const wrapper = this.$(".immersive-wrapper");
      if (wrapper) {
        this._on(wrapper.querySelector(".immersive-nav-prev"), "click", (e) => {
          navClickOrLink(e, () => goToPost(backPost));
        });
        this._on(wrapper.querySelector(".immersive-nav-next"), "click", (e) => {
          navClickOrLink(e, () => goToPost(fwdPost));
        });
      }
    }

    const shareBtn = this.$(".carousel-share-btn");
    if (shareBtn) {
      this._on(shareBtn, "click", (e) => {
        e.stopPropagation();
        const settings = store.get("settings") || {};
        sharePost({
          title: settings.blog_title || document.title,
          url: window.location.href,
        });
      });
    }

    // Fade in on mount
    const fadeTarget =
      slides.length > 0 ? slides[index] : this.$(".immersive-visuals");
    fadeTarget?.classList.add("immersive-fade-in");

    // ── Gestures & Zoom ──
    const wrapper = this.$(".immersive-wrapper");
    const visuals = this.$(".immersive-visuals");

    // Cache nav gradient elements for mousemove updates
    const navRoot = carousel || wrapper;
    const navPrevGrad = navRoot?.querySelector(".immersive-nav-prev .immersive-nav-gradient");
    const navNextGrad = navRoot?.querySelector(".immersive-nav-next .immersive-nav-gradient");

    // Touch gradient feedback for nav panels
    const addNavTouchFeedback = (selector) => {
      const panel = navRoot?.querySelector(selector);
      if (!panel) return;
      const grad = panel.querySelector(".immersive-nav-gradient");
      if (!grad) return;
      this._on(panel, "touchstart", () => { grad.style.opacity = 0.5; }, { passive: true });
      this._on(panel, "touchend",   () => { grad.style.opacity = 0; },   { passive: true });
      this._on(panel, "touchcancel",() => { grad.style.opacity = 0; },   { passive: true });
    };
    addNavTouchFeedback(".immersive-nav-prev");
    addNavTouchFeedback(".immersive-nav-next");

    this._resetZoom = () => {
      this._zoomState = { scale: 1, x: 0, y: 0 };
      this._updateVisuals(0, 0);
      this._gesture?.setZoomed(false);
      wrapper.classList.remove("zoomed");
    };

    const getMaxScale = () => {
      const img = (slides[index] ?? visuals).querySelector("img, video");
      if (!img || (!img.complete && img.tagName === "IMG")) return 2;
      const rect = img.getBoundingClientRect();
      const naturalWidth = img.naturalWidth || img.videoWidth;
      const naturalHeight = img.naturalHeight || img.videoHeight;
      if (!naturalWidth || !naturalHeight) return 2;

      const fillScale = Math.max(
        window.innerWidth / rect.width,
        window.innerHeight / rect.height,
      );
      const naturalScale = naturalWidth / rect.width;

      // Allow zooming to at least fill the screen, or natural size, or at least 2x.
      const max = Math.max(fillScale, naturalScale, 2);
      return max;
    };

    this._constrainZoom = (animate = false) => {
      const { scale } = this._zoomState;
      if (scale <= 1) {
        this._zoomState.x = 0;
        this._zoomState.y = 0;
        this._zoomState.scale = 1;
      } else {
        const img = (slides[index] ?? visuals).querySelector("img, video");
        if (img) {
          const rect = img.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const rangeX = Math.max(0, (rect.width - vw) / 2);
          const rangeY = Math.max(0, (rect.height - vh) / 2);
          this._zoomState.x = Math.max(
            -rangeX,
            Math.min(rangeX, this._zoomState.x),
          );
          this._zoomState.y = Math.max(
            -rangeY,
            Math.min(rangeY, this._zoomState.y),
          );
        }
      }
      const target = slides[index] ?? visuals;
      if (target && animate) {
        target.style.transition = "transform 0.3s ease-out, opacity 0.3s ease";
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
          target.style.opacity = Math.max(
            0.3,
            1 - Math.abs(tx) / window.innerWidth,
          );
        } else if (ty > 0) {
          const s = Math.max(0.5, 1 - ty / window.innerHeight);
          target.style.transform = `translateY(${ty}px) scale(${s})`;
          target.style.opacity = s;
        } else {
          target.style.transform = "";
          target.style.opacity = "1";
        }
      } else {
        // Pan feedback
        target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        target.style.opacity = "1";
      }
      target.style.transition = "none";
    };

    const dismiss = async () => {
      try {
        const params = tagSlug ? { tag: tagSlug } : {};
        const data = await getPostPageLocation(post.slug, params);
        ViewContext.update({ page: data.page, postSlug: null });
      } catch {
        ViewContext.update({ postSlug: null });
      }
    };

    this._gesture = new GestureController(wrapper, {
      onSwipeMove: (dx, dy) => {
        if (Math.abs(dx) > Math.abs(dy)) {
          const n = slides.length;
          const atLastSlide = n === 0 || index === n - 1;
          const atFirstSlide = n === 0 || index === 0;
          const blockedLeft = dx < 0 && atLastSlide && !fwdPost;
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
            target.style.transition = "transform 0.3s ease, opacity 0.3s ease";
            target.style.transform = "";
            target.style.opacity = "1";
          }
        }
      },
      onSwipeCommit: (dir) => {
        if (dir === "left" || dir === "right") {
          const n = slides.length;
          const atLastSlide = n === 0 || index === n - 1;
          const atFirstSlide = n === 0 || index === 0;
          const blocked =
            (dir === "left" && atLastSlide && !fwdPost) ||
            (dir === "right" && atFirstSlide && !backPost);
          if (blocked) {
            // Spring back — same as onSwipeCancel
            const target = slides[index] ?? visuals;
            if (target) {
              target.style.transition =
                "transform 0.3s ease, opacity 0.3s ease";
              target.style.transform = "";
              target.style.opacity = "1";
            }
            return;
          }
        }
        // Swipe left = advance slide (index+1); at last slide crosses to nextPost (newer)
        if (dir === "left") goTo(index + 1);
        else if (dir === "right") goTo(index - 1);
        else if (dir === "down") dismiss();
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
        const newScale = Math.max(
          0.5,
          Math.min(getMaxScale() * 2, oldScale * delta),
        );
        if (newScale === oldScale) return;

        // Zoom relative to pinch center
        const rect = wrapper.getBoundingClientRect();
        const rx = cx - rect.left - rect.width / 2;
        const ry = cy - rect.top - rect.height / 2;

        this._zoomState.x -=
          (rx - this._zoomState.x) * (newScale / oldScale - 1);
        this._zoomState.y -=
          (ry - this._zoomState.y) * (newScale / oldScale - 1);
        this._zoomState.scale = newScale;

        this._gesture.setZoomed(newScale > 1);
        wrapper.classList.toggle("zoomed", newScale > 1);
        this._updateVisuals();
      },
      onTap: (x, y) => {
        // Don't hide/show the overlay when the tap landed on an interactive element
        // (nav arrows, info card, etc.) — those elements handle their own action.
        const tapped = document.elementFromPoint(x, y);
        if (tapped?.closest("a, button, .immersive-nav-panel, input, .post-info-card")) return;
        if (document.body.classList.contains("ui-hidden")) {
          showUI();
        } else {
          hideUI();
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
          wrapper.classList.add("zoomed");
          this._updateVisuals();
        }
      },
    });

    this._trackpad = new TrackpadDetector(wrapper, {
      onHorizontal: (dir) => goTo(index + (dir === "left" ? 1 : -1)),
    });

    // ── UI show / hide ──
    let _mouseDownX = 0,
      _mouseDownY = 0,
      _mouseDragged = false;
    const DRAG_THRESHOLD_PX = 6;

    const showUI = () => {
      if (document.body.classList.contains("ui-hidden")) {
        document.body.classList.remove("ui-hidden");
        this._lastShowTime = Date.now();
      }
    };
    const hideUI = () => {
      if (document.querySelector(".header-search-form.is-active, .tag-group.is-open")) return;
      hideFlyout();
      document.body.classList.add("ui-hidden");
    };

    let lastTouchTime = 0;
    this._on(
      document,
      "touchstart",
      () => { lastTouchTime = Date.now(); },
      { passive: true, capture: true },
    );

    this._on(wrapper, "contextmenu", (e) => {
      e.preventDefault();
    });

    this._on(wrapper, "click", (e) => {
      if (Date.now() - lastTouchTime < 500) return; // Ignore simulated click from touch
      if (e.target.closest("a, button, .immersive-nav-panel, input, .post-info-card")) return;
      if (_mouseDragged) return; // Drag-to-slide — not a click
      if (document.body.classList.contains("ui-hidden")) {
        showUI();
      } else {
        hideUI();
      }
    });

    this._on(
      document,
      "mousemove",
      (e) => {
        if (!_mouseDragged) {
          const dx = e.clientX - _mouseDownX;
          const dy = e.clientY - _mouseDownY;
          if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX)
            _mouseDragged = true;
        }
      },
      { passive: true },
    );
    // Use pointermove (mouse only) for gradient tracking — avoids synthetic mouse
    // events that mobile browsers fire after touch, which would re-show the gradient.
    this._on(document, "pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const x = e.clientX;
      const w = window.innerWidth;
      const zone = w / 3;
      if (navPrevGrad) navPrevGrad.style.opacity = x < zone ? ((1 - x / zone) * 0.5).toFixed(3) : 0;
      if (navNextGrad) navNextGrad.style.opacity = x > w - zone ? (((x - (w - zone)) / zone) * 0.5).toFixed(3) : 0;
    }, { passive: true });
    this._on(document, "pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      if (navPrevGrad) navPrevGrad.style.opacity = 0;
      if (navNextGrad) navNextGrad.style.opacity = 0;
    }, { passive: true });
    this._on(
      document,
      "mousedown",
      (e) => {
        _mouseDownX = e.clientX;
        _mouseDownY = e.clientY;
        _mouseDragged = false;
      },
      { passive: true },
    );

    // ── Keyboard ──
    this._on(document, "keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;
      if (this._zoomState.scale > 1) {
        if (e.key === "Escape") this._resetZoom();
        return;
      }
      const n = slides.length;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goTo(index - 1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goTo(index + 1);
      } else if (e.key === "Escape" || e.key === "ArrowDown") {
        e.preventDefault();
        dismiss();
      } else if (e.key === "Home") {
        e.preventDefault();
        goTo(0);
      } else if (e.key === "End") {
        e.preventDefault();
        goTo(n > 0 ? n - 1 : 0);
      } else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (document.body.classList.contains("ui-hidden")) {
          showUI();
        } else if (Date.now() - this._lastShowTime >= MIN_SHOW_MS) {
          hideUI();
        }
      }
    });

    this._lastShowTime = Date.now();
    if (_overlayHidden) {
      hideUI();
    }
  }

  _initNormal(prevPost, nextPost) {
    // Direction aliases — same setting as immersive mode.
    const settings = store.get("settings") || {};
    const feedMode = settings.immersive_nav_direction === "feed";
    const backPost = feedMode ? nextPost : prevPost; // left swipe / ◁
    const fwdPost = feedMode ? prevPost : nextPost; // right swipe / ▷

    // No drag-transform feedback on a scrollable page — it fights browser scroll.
    // Just commit on a clean horizontal swipe.
    this._gesture = new GestureController(this.container, {
      onSwipeCommit: (dir) => {
        if (dir === "left" && backPost) ViewContext.update({ postSlug: backPost.slug });
        else if (dir === "right" && fwdPost) ViewContext.update({ postSlug: fwdPost.slug });
      },
    });
    this._trackpad = new TrackpadDetector(this.container, {
      onHorizontal: (dir) => {
        if (dir === "left" && backPost) ViewContext.update({ postSlug: backPost.slug });
        else if (dir === "right" && fwdPost) ViewContext.update({ postSlug: fwdPost.slug });
      },
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
    const navTags = store.get("navTags") || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    const tags = renderTagStrip(post.tags, tagIndex);
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);
    const postCss = post.css ? `<style id="post-css">${post.css}</style>` : "";

    return `
      <article class="post-single${isHidden ? " is-hidden" : ""}" itemscope itemtype="https://schema.org/BlogPosting">
        ${postCss}<div class="post-content" itemprop="articleBody">${post.content_html || ""}</div>

        ${
          tags
            ? `<footer class="post-footer">
               ${tags}
             </footer>`
            : ""
        }

        ${this._renderNav(prevPost, nextPost)}
      </article>
      ${this._renderNormalPostArrows(prevPost, nextPost)}`;
  }

  /** Render fixed-position prev/next post arrow buttons for the normal (non-immersive) layout. */
  _renderNormalPostArrows(prevPost, nextPost) {
    if (!prevPost && !nextPost) return "";
    const prev = prevPost
      ? `<a href="/posts/${escapeHtml(prevPost.slug)}" class="post-side-nav-btn prev" aria-label="Previous post">&#10094;</a>`
      : "";
    const next = nextPost
      ? `<a href="/posts/${escapeHtml(nextPost.slug)}" class="post-side-nav-btn next" aria-label="Next post">&#10095;</a>`
      : "";
    return `<nav class="post-side-nav" aria-label="Post side navigation">${prev}${next}</nav>`;
  }

  _enhanceLinks(body) {
    body.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  _enhanceMedia(body) {
    const { onEnterImmersive, post } = this.props;
    const fallbackAlt = post?.excerpt || post?.title || "";

    // Apply fallback alt text to any image that lacks one.
    body.querySelectorAll("img").forEach((img) => {
      if (!img.getAttribute("alt")) img.setAttribute("alt", fallbackAlt);
    });

    if (onEnterImmersive) {
      const items = this._mediaFromHtml(post.content_html || "");
      const images = Array.from(body.querySelectorAll("img")).filter(
        (img) => !img.closest("a[href]"),
      );
      images.forEach((img) => {
        img.classList.add("zoomable");
        img.setAttribute("tabindex", "0");
        const enter = () => {
          const src = img.getAttribute("src");
          // Find which slide index this image belongs to.
          const idx = items.findIndex(
            (item) =>
              item.url === src ||
              (item.type === "html" && item.html.includes(src)),
          );
          onEnterImmersive(idx >= 0 ? idx : 0);
        };
        img.addEventListener("click", enter);
        img.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            enter();
          }
        });
      });
    }
    body
      .querySelectorAll("audio, video")
      .forEach((el) => el.setAttribute("controls", ""));

    // EXIF overlays — normal mode only, when visibility allows and post has media
    if (this._exifVisible() && post?.media?.length) {
      const mediaMap = {};
      for (const m of post.media) {
        if (m.path) mediaMap[m.path] = m;
      }

      body.querySelectorAll("img").forEach((img) => {
        let src = img.src || "";
        try {
          src = new URL(src).pathname;
        } catch {
          /* already relative */
        }
        src = src.replace(/\?(?:thumb)$/, "");
        const media = mediaMap[src];
        if (!media || !media.metadata || !Object.keys(media.metadata).length)
          return;

        const figure = document.createElement("figure");
        figure.className = "media-exif-wrapper";
        img.parentNode.insertBefore(figure, img);
        figure.appendChild(img);

        const btn = document.createElement("button");
        btn.className = "exif-info-btn";
        btn.setAttribute("aria-label", "Show EXIF data");
        btn.setAttribute("aria-expanded", "false");
        btn.textContent = "\u2139";
        figure.appendChild(btn);

        const overlay = document.createElement("div");
        overlay.className = "exif-overlay";
        overlay.setAttribute("role", "complementary");
        overlay.setAttribute("aria-label", "EXIF data");
        const title = document.createElement("div");
        title.className = "exif-overlay-title";
        title.textContent = "Camera data";
        overlay.appendChild(title);
        const table = document.createElement("table");
        const tbody = document.createElement("tbody");
        Object.entries(media.metadata).forEach(([k, v]) => {
          const tr = document.createElement("tr");
          const tdKey = document.createElement("td");
          tdKey.textContent = String(k);
          const tdVal = document.createElement("td");
          tdVal.textContent = String(v);
          tr.appendChild(tdKey);
          tr.appendChild(tdVal);
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        overlay.appendChild(table);
        figure.appendChild(overlay);

        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const isVisible = overlay.classList.toggle("is-visible");
          btn.classList.toggle("is-active", isVisible);
          btn.setAttribute("aria-expanded", String(isVisible));
        });
      });
    }
  }

  _enhanceCodeBlocks(body) {
    const parseSvg = (svgString) => {
      const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
      return doc.documentElement;
    };

    const toHighlight = [];

    body.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code) return;

      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.setAttribute("aria-label", "Copy code");
      btn.appendChild(parseSvg(COPY_SVG));

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(code.textContent || "").then(() => {
          btn.replaceChildren(parseSvg(CHECK_SVG));
          btn.classList.add("copied");
          setTimeout(() => {
            btn.replaceChildren(parseSvg(COPY_SVG));
            btn.classList.remove("copied");
          }, 1500);
        }).catch(() => {});
      });

      pre.appendChild(btn);

      const m = code.className.match(/\blanguage-(\w+)/);
      if (m) toHighlight.push({ code, lang: m[1] });
    });

    if (toHighlight.length === 0) return;

    (async () => {
      await _ensurePrismCore();
      const langs = [...new Set(toHighlight.map((x) => x.lang))];
      await Promise.all(langs.map(_loadPrismLang));
      toHighlight.forEach(({ code }) => window.Prism.highlightElement(code));
    })();
  }

  _renderNav(prev, next) {
    if (!prev && !next) return "";
    const prevLink = prev
      ? `<a href="/posts/${escapeHtml(prev.slug)}" class="post-nav-link prev" rel="prev">
           <span class="nav-label">Previous</span>
           <span class="nav-title">${escapeHtml(prev.title)}</span>
         </a>`
      : "<span></span>";
    const nextLink = next
      ? `<a href="/posts/${escapeHtml(next.slug)}" class="post-nav-link next" rel="next">
           <span class="nav-label">Next</span>
           <span class="nav-title">${escapeHtml(next.title)}</span>
         </a>`
      : "<span></span>";
    return `<nav class="post-navigation" aria-label="Post navigation">${prevLink}${nextLink}</nav>`;
  }
}
