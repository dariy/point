/**
 * PostContent — renders a full post (header, body, tags, navigation).
 *
 * The post body (content_html) is server-generated and sanitized server-side.
 * It is included directly in the render() string so the Component base class
 * inserts it along with all other markup — no separate assignment needed.
 * All other values are escaped with escapeHtml().
 *
 * Props:
 *   post           {object}    Full post from GET /api/posts/slug/:slug
 *   showViewCount  {boolean}
 *   prevPost       {object|null}
 *   nextPost       {object|null}
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';
import { formatDate, isoDatetime } from '../../utils/formatters.js';
import { MediaLightbox } from './MediaLightbox.js';

export class PostContent extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._lightbox = null;
  }

  render() {
    const { post, showViewCount = false, prevPost = null, nextPost = null } = this.props;
    if (!post) return '';

    const tags = (post.tags || []).map((t) => {
      const slug = typeof t === 'string' ? t : t.slug;
      const name = typeof t === 'string' ? t : t.name;
      return `<a href="/tag/${escapeHtml(slug)}" class="post-tag">${escapeHtml(name)}</a>`;
    }).join('');

    const viewCount = showViewCount && post.view_count != null
      ? `<span class="view-count">${escapeHtml(String(post.view_count))} views</span>` : '';

    const author = post.author?.display_name || post.author?.username || '';

    // content_html is sanitized server-side — included in the HTML string
    // passed to the base Component, which handles the insertion.
    const body = post.content_html || '';

    const nav = this._renderNav(prevPost, nextPost);

    return `
      <article class="post-single" itemscope itemtype="https://schema.org/BlogPosting">
        <header class="post-header">
          <h1 class="post-title" itemprop="headline">${escapeHtml(post.title)}</h1>
          <div class="post-meta">
            <time class="post-date"
                  datetime="${escapeHtml(isoDatetime(post.published_at || post.created_at))}">
              ${escapeHtml(formatDate(post.published_at || post.created_at))}
            </time>
            ${author ? `<span class="post-author" itemprop="author">${escapeHtml(author)}</span>` : ''}
            ${viewCount}
          </div>
        </header>

        ${post.thumbnail_path
          ? `<div class="post-featured-image">
               <img src="${escapeHtml(post.thumbnail_path)}"
                    alt="${escapeHtml(post.title)}"
                    loading="lazy" itemprop="image">
             </div>`
          : ''}

        <div class="post-content" itemprop="articleBody">${body}</div>

        ${tags
          ? `<footer class="post-footer">
               <div class="post-tags" aria-label="Tags">${tags}</div>
             </footer>`
          : ''}

        ${nav}
      </article>`;
  }

  afterRender() {
    const bodyEl = this.$('.post-content');
    if (bodyEl) {
      this._enhanceMedia(bodyEl);
    }
  }

  beforeUnmount() {
    if (this._lightbox) {
      this._lightbox.destroy();
      this._lightbox = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Attach a lightbox to images and ensure audio/video have controls.
   * @param {HTMLElement} body
   */
  _enhanceMedia(body) {
    const images = Array.from(body.querySelectorAll('img')).filter(
      (img) => !img.closest('a[href]')
    );

    if (images.length) {
      this._lightbox = new MediaLightbox();
      const imageData = images.map((img) => ({
        src: img.src,
        alt: img.alt || img.title || '',
      }));
      images.forEach((img, i) => {
        img.style.cursor = 'zoom-in';
        img.setAttribute('tabindex', '0');
        const open = () => this._lightbox.open(imageData, i);
        img.addEventListener('click', open);
        img.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
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
