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
import { html, raw, safeUrl } from "../../utils/helpers.js";
import { cardImageSizes } from "../../utils/gridFit.js";
import { thumbAttrs } from "../../utils/mediaUrl.js";
import { formatDateShort } from "../../utils/formatters.js";
import { LOCK_SVG } from "../../utils/icons.js";
import { store } from "../../store.js";
import { buildTagIndex, parseTagUrl } from "../../utils/tagLinks.js";
import { renderTagStrip, setupTagStrip } from "../../utils/tagStrip.js";
import { ViewContext } from "../../utils/viewContext.js";

const VIDEO_RE = /\.(?:mp4|webm|mov|ogv|m4v|avi|mkv)$/i;

// Touch previews are exclusive across the grid: the reveal tap on one card
// closes every other card's overlay, so the card that lost its overlay must
// lose its video with it. Cards are separate component instances, so the
// running preview is tracked here rather than on any one of them.
let touchPreview = null;

export class PostCard extends Component {
  render() {
    const { post, showViewCount = false, isHero = false } = this.props;
    if (!post) return html``;

    const mediaUrl = post.media_url || null;
    const isVideo = mediaUrl && VIDEO_RE.test(mediaUrl);
    const hasMedia = !!mediaUrl;
    // Cards paint a rung of the thumbnail ladder, never the original: a grid of
    // full-size photos runs to tens of megabytes a page. A rung serves the
    // derived thumbnail for a still and the stored poster frame for a video, so
    // a card costs the same either way and no video streams unasked. A video
    // with no stored poster 404s every rung and leaves the card unpainted (see
    // afterRender) — the play indicator below still marks it as playable.
    //
    // safeUrl first, so a hostile media_url is dropped rather than dressed up
    // as four variant URLs. The card keeps its `has-image` shape either way:
    // whether media paints is not a question about the card's layout.
    const posterUrl = hasMedia ? safeUrl(mediaUrl) : "#";
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);
    // A post waiting on its publish time. Only the owner is ever handed one
    // (the server keeps them off every public payload), and it is drawn faded
    // so a page of them is never mistaken for the live feed.
    const isScheduled = post.status === "scheduled";
    const cardClass = [
      "post-card",
      hasMedia ? "has-image" : "text-only",
      isHidden ? "is-hidden" : "",
      isScheduled ? "is-scheduled" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const lockIcon = isHidden ? raw(LOCK_SVG) : "";
    // Scheduled posts have no published_at yet, and their created_at is when
    // the draft was started — neither is the date the card is about. Show the
    // time it goes live instead.
    const cardDate = isScheduled
      ? post.scheduled_at
      : post.published_at || post.created_at;

    // A real <img>, not a CSS background-image: only the element form carries a
    // srcset, and the ladder is the whole point — a card three-across on a
    // desktop and the same card alone on a phone are different images. `sizes`
    // is the measured track width (gridFit), because the column count comes
    // from auto-fill or from a stored zoom, neither of which a media query can
    // see. The CSS to receive it (object-fit: cover, the hover scale) has been
    // in post-grid.css all along, written for the video branch.
    const bgImage =
      posterUrl !== "#"
        ? html`<img ${thumbAttrs(posterUrl, { sizes: cardImageSizes(isHero) })}
                alt="" loading="lazy" decoding="async">`
        : "";

    const playIndicator = isVideo
      ? html`
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
        ? html`<span class="view-count">${String(post.view_count)} views</span>`
        : "";

    return html`
      <article class="${cardClass}" role="button" tabindex="0"
               data-post-slug="${post.slug}">
        <div class="post-card-background">${bgImage}</div>
        ${playIndicator}
        <div class="post-card-content${hasMedia ? " overlay" : ""}">
          <h2 class="post-card-title">${lockIcon}${post.title}</h2>
          ${post.excerpt ? html`<p class="post-card-excerpt">${post.excerpt}</p>` : ""}
          <div class="post-card-meta">
            <time datetime="${cardDate || ""}"
                  class="post-date${isScheduled ? " post-date-scheduled" : ""}">
              ${isScheduled ? "⏱ " : ""}${formatDateShort(cardDate)}
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

    // A video that never got a poster frame 404s every rung of the ladder. As
    // a background-image that was silent — the card simply stayed unpainted —
    // but an <img> whose src fails paints the browser's broken-image glyph
    // instead, in the middle of a photo grid. Drop the element and the card is
    // unpainted again, which is what it was before and what the play indicator
    // already accounts for. (The ghost grids gridPager builds carry no
    // component, so they arrange the same thing by delegation — see
    // dropBrokenImages.)
    const poster = card.querySelector(".post-card-background img");
    const mediaUrl = post.media_url || null;

    if (poster) {
      poster.addEventListener("error", () => {
        poster.remove();
        // If a video has no poster frame, it 404s and leaves the card blank.
        // To fix "unhovered state shows no preview", we fall back to a paused
        // <video> element to display the first frame.
        if (mediaUrl && VIDEO_RE.test(mediaUrl)) {
          const bg = card.querySelector(".post-card-background");
          if (bg) {
            const v = document.createElement("video");
            v.src = safeUrl(mediaUrl) + "#t=0.001";
            v.muted = true;
            v.playsInline = true;
            v.preload = "metadata";
            bg.appendChild(v);
          }
        }
      }, { once: true });
    }

    // Hover-to-play is opt-in per site (post-list plugin setting). Off, a video
    // card stays a poster frame until the reader opens the post.
    const hoverAutoplay = !!(store.get("settings") || {})
      .enable_video_hover_autoplay;
    if (hoverAutoplay && mediaUrl && VIDEO_RE.test(mediaUrl)) {
      this._setupHoverVideo(card, mediaUrl);
    }

    this.subscribeStore(store, "navTags", () => this._rerender());

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
      // Drop the play glyph only once frames are actually running: if autoplay
      // is blocked the card stays a poster frame and still needs its marker.
      v.addEventListener("playing", () => card.classList.add("is-playing"));
      bg.appendChild(v);
      this._hoverVideo = v;
      // Autoplay policy or a decode failure leaves the poster showing, which is
      // the same thing the reader sees with the setting off — nothing to report.
      v.play?.().catch(() => {});
    };

    const stop = () => {
      if (touchPreview === this) touchPreview = null;
      card.classList.remove("is-playing");
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
