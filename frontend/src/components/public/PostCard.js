/**
 * PostCard — a single post entry in the grid.
 *
 * The entire card is clickable (navigates to the post) except tag links,
 * which navigate to their respective tag pages.
 *
 * Props:
 *   post           {object}   Post list item from the API
 *   showViewCount  {boolean}  Show view count if true (from settings.show_view_counts)
 *   isHero         {boolean}  True for the first featured post (hero slot)
 */

import { Component } from "../Component.js";
import { escapeHtml, safeUrl } from "../../utils/helpers.js";
import { formatDateShort } from "../../utils/formatters.js";
import { LOCK_SVG } from "../../utils/icons.js";
import { store } from "../../store.js";
import {
  buildTagIndex,
  parseTagUrl,
  renderTagStrip,
  setupTagStrip,
} from "../../utils/tags.js";
import { ViewContext } from "../../utils/viewContext.js";

const VIDEO_RE = /\.(?:mp4|webm|mov|ogv|m4v|avi|mkv)$/i;

// Touch previews are exclusive across the grid: the reveal tap on one card
// closes every other card's overlay, so the card that lost its overlay must
// lose its video with it. Cards are separate component instances, so the
// running preview is tracked here rather than on any one of them.
let touchPreview = null;

export class PostCard extends Component {
  render() {
    const { post, showViewCount = false } = this.props;
    if (!post) return "";

    const mediaUrl = post.media_url || null;
    const isVideo = mediaUrl && VIDEO_RE.test(mediaUrl);
    const hasMedia = !!mediaUrl;
    // Cards paint the thumbnail variant, never the original: a grid of
    // full-size photos runs to tens of megabytes a page. `?thumb` serves the
    // stored thumbnail for a still and the stored poster frame for a video, so
    // a card costs the same either way and no video streams unasked. A video
    // with no stored poster 404s here and simply leaves the card unpainted —
    // the play indicator below still marks it as playable.
    const posterUrl = hasMedia ? `${mediaUrl}?thumb` : null;
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);
    const cardClass = [
      "post-card",
      hasMedia ? "has-image" : "text-only",
      isHidden ? "is-hidden" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const lockIcon = isHidden ? LOCK_SVG : "";

    const bgStyle = hasMedia
      ? ` style="background-image: url('${safeUrl(posterUrl)}')"`
      : "";

    const playIndicator = isVideo
      ? `
      <div class="video-play-indicator">
        <svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="25" fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.8)" stroke-width="1.5"/>
          <polygon points="21,17 37,26 21,35" fill="white"/>
        </svg>
      </div>`
      : "";

    const tags = renderTagStrip(post.tags);

    const viewCount =
      showViewCount && post.view_count != null
        ? `<span class="view-count">${escapeHtml(String(post.view_count))} views</span>`
        : "";

    return `
      <article class="${cardClass}" role="button" tabindex="0"
               data-post-slug="${escapeHtml(post.slug)}">
        <div class="post-card-background"${bgStyle}></div>
        ${playIndicator}
        <div class="post-card-content${hasMedia ? " overlay" : ""}">
          <h2 class="post-card-title">${lockIcon}${escapeHtml(post.title)}</h2>
          ${post.excerpt ? `<p class="post-card-excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
          <div class="post-card-meta">
            <time datetime="${escapeHtml(post.published_at || post.created_at || "")}"
                  class="post-date">
              ${escapeHtml(formatDateShort(post.published_at || post.created_at))}
            </time>
            ${viewCount}
          </div>
          ${tags}
        </div>
      </article>`;
  }

  afterRender() {
    const { post, tagSlug } = this.props;
    if (!post) return;
    const card = this.$(".post-card");
    if (!card) return;

    this._cleanupStrip?.();
    this._stopHoverVideo?.();
    this._stopHoverVideo = null;
    this._startTouchVideo = null;

    // Hover-to-play is opt-in per site (post-list plugin setting). Off, a video
    // card stays a poster frame until the reader opens the post.
    const mediaUrl = post.media_url || null;
    const hoverAutoplay = !!(store.get("settings") || {})
      .enable_video_hover_autoplay;
    if (hoverAutoplay && mediaUrl && VIDEO_RE.test(mediaUrl)) {
      this._setupHoverVideo(card, mediaUrl);
    }

    if (!this._subscribed) {
      this.subscribeStore(store, "navTags", () => this._rerender());
      this._subscribed = true;
    }

    const go = () => {
      this._stopHoverVideo?.();
      if (tagSlug) {
        ViewContext.update({ postSlug: post.slug });
      } else {
        ViewContext.update({ postSlug: post.slug, tag: null, query: null });
      }
    };

    // Image cards have an overlay hidden until the first tap (touch/stylus).
    // On mouse devices the overlay is already visible via CSS :hover, so the
    // first click navigates directly. Touch/stylus interactions still use the
    // two-tap pattern: first tap reveals, second tap navigates.
    const hasOverlay = card.classList.contains("has-image");

    let lastPointerType = "mouse";
    card.addEventListener("pointerdown", (e) => {
      lastPointerType = e.pointerType;
    });

    if (hasOverlay) {
      // Buttons inside the card (the tag strip's scroll arrows) stop the click
      // themselves when they act on it, so anything still arriving here is the
      // card's own — including a tap on an arrow that is invisible until the
      // overlay is revealed, which must count as that reveal tap.
      card.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        const needsTwoTap =
          lastPointerType !== "mouse" && !card.classList.contains("is-touched");
        if (needsTwoTap) {
          // Tag links with ancestor flyouts manage their own first-tap behavior.
          if (e.target.closest(".has-flyout")) return;

          // First tap — reveal the overlay.
          e.preventDefault();
          e.stopPropagation();

          document.querySelectorAll(".post-card.is-touched").forEach((c) => {
            if (c !== card) c.classList.remove("is-touched");
          });

          card.classList.add("is-touched");

          // The reveal tap is the touch equivalent of hovering in: it is the
          // reader asking for this card, and the only gesture before the tap
          // that opens the post. Playing here keeps the preview reachable on
          // touch without ever loading video for a card merely scrolled past.
          this._startTouchVideo?.();

          const dismiss = (ev) => {
            if (!card.contains(ev.target)) {
              card.classList.remove("is-touched");
              this._stopHoverVideo?.();
              document.removeEventListener("click", dismiss, true);
            }
          };
          document.addEventListener("click", dismiss, true);
        } else {
          go();
        }
      });
    } else {
      card.addEventListener("click", (e) => {
        if (e.target.closest("a, button")) return;
        go();
      });
    }

    // Firefox doesn't focus non-interactive elements on click; force it so arrow key
    // navigation in PostGrid works consistently across browsers.
    card.addEventListener("mousedown", (e) => {
      if (!e.target.closest("a, button")) card.focus({ preventScroll: true });
    });

    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });

    // Unified tag strip scrolling and flyout setup
    const navTags = store.get("navTags") || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupStrip = setupTagStrip(card, tagIndex, (url) => {
      const { tag, navPath } = parseTagUrl(url);
      ViewContext.update({ tag, navPath, postSlug: null, query: null });
    }, card);
  }

  /**
   * Attach hover-to-play to a video card.
   *
   * The <video> is built on the first hover and torn down on leave, so a grid
   * the reader merely scrolls past never opens a media connection — the whole
   * point of defaulting to a poster frame.
   *
   * Touch has no hover, so the reveal tap stands in for it: the card's click
   * handler calls `_startTouchVideo` when it reveals the overlay, and stops on
   * the dismissing tap outside. Pointer enter/leave stay mouse-only — a touch
   * fires both around a single tap, which would start and stop the video in
   * the same gesture.
   *
   * @param {HTMLElement} card      the .post-card element
   * @param {string}      mediaUrl  original media path (not the poster)
   */
  _setupHoverVideo(card, mediaUrl) {
    const bg = card.querySelector(".post-card-background");
    if (!bg) return;

    const start = () => {
      if (this._hoverVideo) return;
      const v = document.createElement("video");
      v.src = safeUrl(mediaUrl);
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      bg.appendChild(v);
      this._hoverVideo = v;
      // Autoplay policy or a decode failure leaves the poster showing, which is
      // the same thing the reader sees with the setting off — nothing to report.
      v.play?.().catch(() => {});
    };

    const stop = () => {
      if (touchPreview === this) touchPreview = null;
      const v = this._hoverVideo;
      if (!v) return;
      this._hoverVideo = null;
      v.pause();
      // Drop the buffered stream rather than leaving it parked in memory for
      // every card the reader has passed over.
      v.removeAttribute("src");
      v.load();
      v.remove();
    };

    card.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") start();
    });
    card.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") stop();
    });

    this._stopHoverVideo = stop;
    this._startTouchVideo = () => {
      // Revealing this card closed the previously revealed one; take its video
      // down too, so a reader tapping along a grid never leaves clips playing
      // behind them.
      if (touchPreview && touchPreview !== this) touchPreview._stopHoverVideo?.();
      touchPreview = this;
      start();
    };
  }

  beforeUnmount() {
    this._cleanupStrip?.();
    this._stopHoverVideo?.();
    if (touchPreview === this) touchPreview = null;
  }
}
