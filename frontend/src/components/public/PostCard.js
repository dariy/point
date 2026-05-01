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

import { Component } from '../Component.js';
import { escapeHtml, safeUrl, navigate } from '../../utils/helpers.js';
import { formatDateShort } from '../../utils/formatters.js';
import { LOCK_SVG } from '../../utils/icons.js';
import { store } from '../../store.js';
import { buildTagIndex, renderTagStrip, setupTagStrip } from '../../utils/tags.js';

export class PostCard extends Component {
  render() {
    const { post, showViewCount = false, useThumbnails = true, isHero = false } = this.props;
    if (!post) return '';

    const mediaUrl = post.media_url || null;
    const isVideo = mediaUrl && /\.(?:mp4|webm|mov|ogv|m4v|avi|mkv)$/i.test(mediaUrl);
    const hasMedia = !!mediaUrl && useThumbnails;
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);
    const cardClass = ['post-card', hasMedia ? 'has-image' : 'text-only', isHidden ? 'is-hidden' : ''].filter(Boolean).join(' ');
    const lockIcon = isHidden ? LOCK_SVG : '';

    const bgStyle = (hasMedia && !isVideo)
      ? ` style="background-image: url('${safeUrl(mediaUrl)}')"` : '';

    const bgVideo = isVideo
      ? `<video src="${safeUrl(mediaUrl)}" autoplay muted loop playsinline></video>` : '';

    const playIndicator = isVideo ? `
      <div class="video-play-indicator">
        <svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="25" fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.8)" stroke-width="1.5"/>
          <polygon points="21,17 37,26 21,35" fill="white"/>
        </svg>
      </div>` : '';

    const navTags = store.get('navTags') || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    const tags = renderTagStrip(post.tags, tagIndex);

    const viewCount = showViewCount && post.view_count != null
      ? `<span class="view-count">${escapeHtml(String(post.view_count))} views</span>` : '';

    const featured = isHero
      ? `<span class="featured-badge" aria-label="Featured">Featured</span>` : '';

    return `
      <article class="${cardClass}" role="button" tabindex="0"
               data-post-slug="${escapeHtml(post.slug)}">
        <div class="post-card-background"${bgStyle}>${bgVideo}</div>
        ${playIndicator}
        <div class="post-card-content${hasMedia ? ' overlay' : ''}">
          ${featured}
          <h2 class="post-card-title">${lockIcon}${escapeHtml(post.title)}</h2>
          ${post.excerpt ? `<p class="post-card-excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
          <div class="post-card-meta">
            <time datetime="${escapeHtml(post.published_at || post.created_at || '')}"
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
    const { post, tagSlug, tagPage } = this.props;
    if (!post) return;
    const card = this.$('.post-card');
    if (!card) return;

    this._cleanupStrip?.();

    if (!this._subscribed) {
      this.subscribeStore(store, 'navTags', () => this._rerender());
      this._subscribed = true;
    }

    const go = () => {
      if (tagSlug) {
        const page = tagPage > 1 ? `&page=${tagPage}` : '';
        navigate(`/tag/${tagSlug}?slug=${post.slug}${page}`);
      } else {
        navigate(`/post/${post.slug}`);
      }
    };

    // Image cards have an overlay hidden until the first click/tap.
    // First interaction: reveal the overlay. Second: navigate or follow tag links.
    // This applies to all pointer types (mouse, touch, stylus).
    const hasOverlay = card.classList.contains('has-image');

    if (hasOverlay) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        if (!card.classList.contains('is-touched')) {
          // Tag links with ancestor flyouts manage their own first-click behavior.
          // Don't intercept — let setupTagFlyout handle it cleanly.
          if (e.target.closest('.has-flyout')) return;

          // First click — reveal the overlay.
          e.preventDefault();
          e.stopPropagation();

          // Dismiss any other revealed cards.
          document.querySelectorAll('.post-card.is-touched').forEach((c) => {
            if (c !== card) c.classList.remove('is-touched');
          });

          card.classList.add('is-touched');

          // Dismiss when clicking outside this card.
          const dismiss = (ev) => {
            if (!card.contains(ev.target)) {
              card.classList.remove('is-touched');
              document.removeEventListener('click', dismiss, true);
            }
          };
          document.addEventListener('click', dismiss, true);
        } else {
          // Second click — behave normally.
          go();
        }
      });
    } else {
      card.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        go();
      });
    }

    // Firefox doesn't focus non-interactive elements on click; force it so arrow key
    // navigation in PostGrid works consistently across browsers.
    card.addEventListener('mousedown', (e) => {
      if (!e.target.closest('a')) card.focus({ preventScroll: true });
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });

    // Unified tag strip scrolling and flyout setup
    const navTags = store.get('navTags') || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupStrip = setupTagStrip(card, tagIndex, navigate, card);
  }

  beforeUnmount() {
    this._cleanupStrip?.();
  }
}
