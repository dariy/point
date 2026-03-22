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
import { renderTagLink, buildTagIndex, getTagAncestors } from '../../utils/tags.js';

// Single shared flyout element reused across all PostCard instances.
// Built with DOM methods to avoid XSS risks.
let _flyoutEl = null;
let _activeLink = null;

function getFlyoutEl() {
  if (!_flyoutEl) {
    _flyoutEl = document.createElement('div');
    _flyoutEl.className = 'post-card-tag-flyout';
    _flyoutEl.style.display = 'none';
    document.body.appendChild(_flyoutEl);
  }
  return _flyoutEl;
}

function showFlyout(anchorEl, ancestors) {
  const flyout = getFlyoutEl();

  // Rebuild links using safe DOM construction (no innerHTML with user data).
  while (flyout.firstChild) flyout.removeChild(flyout.firstChild);
  ancestors.forEach((t) => {
    const a = document.createElement('a');
    a.href = `/tag/${encodeURIComponent(t.slug)}`;
    a.className = 'tag-link';
    a.textContent = t.name;
    flyout.appendChild(a);
  });

  // Measure while hidden to get correct dimensions before positioning.
  flyout.style.visibility = 'hidden';
  flyout.style.display = 'flex';
  const flyH = flyout.offsetHeight;  // forces synchronous layout
  const flyW = flyout.offsetWidth;

  // Position above the anchor tag.
  const anchorRect = anchorEl.getBoundingClientRect();
  const gap = 6;

  let top = anchorRect.top - flyH - gap;
  top = Math.max(8, top);  // clamp — don't overflow above viewport

  let left = anchorRect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - flyW - 8));

  flyout.style.top = `${top}px`;
  flyout.style.left = `${left}px`;
  flyout.style.visibility = '';  // reveal at correct position
}

function hideFlyout() {
  if (_flyoutEl) _flyoutEl.style.display = 'none';
  if (_activeLink) {
    _activeLink._flyoutShown = false;
    _activeLink = null;
  }
}

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
    const visibleTags = (post.tags || []).filter((t) => {
      if (!tagIndex) return true;           // navTags not loaded — show all
      const entry = tagIndex.get(t.slug);
      return !entry || entry.isLeaf;        // not in tree → treat as leaf
    });
    const tags = visibleTags.map((t) => renderTagLink(t)).join('');

    const viewCount = showViewCount && post.view_count != null
      ? `<span class="view-count">${escapeHtml(String(post.view_count))} views</span>` : '';

    const featured = isHero
      ? `<span class="featured-badge" aria-label="Featured">Featured</span>` : '';

    return `
      <article class="${cardClass}" role="button" tabindex="0"
               data-post-slug="${escapeHtml(post.slug)}" style="cursor:pointer">
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
          ${tags ? `<div class="post-card-tags" aria-label="Tags">${tags}</div>` : ''}
        </div>
      </article>`;
  }

  afterRender() {
    const { post, tagSlug, tagPage } = this.props;
    if (!post) return;
    const card = this.$('.post-card');
    if (!card) return;

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
        if (!card.classList.contains('is-touched')) {
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
          // Second click — behave normally (tag links fire themselves; card click navigates).
          if (!e.target.closest('a')) go();
        }
      });
    } else {
      card.addEventListener('click', (e) => {
        if (!e.target.closest('a')) go();
      });
    }

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });

    // Prevent the page from scrolling while the user swipes the tags strip
    // horizontally. touch-action CSS alone is unreliable on iOS Safari.
    const tagsEl = card.querySelector('.post-card-tags');
    if (tagsEl) {
      let _touchStartX = 0, _touchStartY = 0;
      tagsEl.addEventListener('touchstart', (e) => {
        _touchStartX = e.touches[0].clientX;
        _touchStartY = e.touches[0].clientY;
      }, { passive: true });
      tagsEl.addEventListener('touchmove', (e) => {
        const dx = Math.abs(e.touches[0].clientX - _touchStartX);
        const dy = Math.abs(e.touches[0].clientY - _touchStartY);
        if (dx > dy) e.preventDefault(); // horizontal swipe — keep scroll in strip
      }, { passive: false });
    }

    // Tag flyout: first click shows ancestors, second click navigates.
    const navTagsAR = store.get('navTags') || [];
    const tagIndexAR = navTagsAR.length ? buildTagIndex(navTagsAR) : null;

    card.querySelectorAll('.post-card-tags .tag-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        if (!tagIndexAR) return; // no hierarchy — navigate normally

        const slug = link.getAttribute('href').replace('/tag/', '');
        const ancestors = getTagAncestors(slug, tagIndexAR);
        if (!ancestors.length) return; // no ancestors — navigate normally

        e.preventDefault();
        e.stopPropagation();

        if (link._flyoutShown) {
          // Second click — navigate to the leaf tag page.
          link._flyoutShown = false;
          hideFlyout();
          navigate(`/tag/${slug}`);
        } else {
          // First click — show the ancestor flyout.
          // Clear any other open flyout on this card first.
          card.querySelectorAll('.post-card-tags .tag-link').forEach((l) => { l._flyoutShown = false; });
          _activeLink = link;
          link._flyoutShown = true;
          showFlyout(link, ancestors);
        }
      });
    });

    this._dismissFlyout = (e) => {
      if (_flyoutEl && !_flyoutEl.contains(e.target) && !card.contains(e.target)) {
        hideFlyout();
        card.querySelectorAll('.post-card-tags .tag-link').forEach((l) => { l._flyoutShown = false; });
      }
    };
    this._dismissFlyoutOnScroll = () => {
      hideFlyout();
      card.querySelectorAll('.post-card-tags .tag-link').forEach((l) => { l._flyoutShown = false; });
    };

    document.addEventListener('click', this._dismissFlyout, true);
    window.addEventListener('scroll', this._dismissFlyoutOnScroll, { passive: true });
  }

  beforeUnmount() {
    if (this._dismissFlyout) {
      document.removeEventListener('click', this._dismissFlyout, true);
    }
    if (this._dismissFlyoutOnScroll) {
      window.removeEventListener('scroll', this._dismissFlyoutOnScroll, { passive: true });
    }
    hideFlyout();
  }
}
