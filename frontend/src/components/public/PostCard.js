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

export class PostCard extends Component {
  render() {
    const { post, showViewCount = false, isHero = false } = this.props;
    if (!post) return '';

    const hasThumbnail = !!post.thumbnail_path;
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);
    const cardClass = ['post-card', hasThumbnail ? 'has-image' : 'text-only', isHidden ? 'is-hidden' : ''].filter(Boolean).join(' ');
    const lockIcon = isHidden ? `<span class="locker-icon" title="Hidden">🔒</span>` : '';

    const thumbnailStyle = hasThumbnail
      ? ` style="background-image: url('${safeUrl(post.thumbnail_path)}')"` : '';

    const tags = (post.tags || []).slice(0, 3).map((t) =>
      `<a href="/tag/${escapeHtml(typeof t === 'string' ? t : t.slug)}" class="tag-link">${escapeHtml(typeof t === 'string' ? t : t.name)}</a>`
    ).join('');

    const viewCount = showViewCount && post.view_count != null
      ? `<span class="view-count">${escapeHtml(String(post.view_count))} views</span>` : '';

    const featured = isHero
      ? `<span class="featured-badge" aria-label="Featured">Featured</span>` : '';

    return `
      <article class="${cardClass}" role="button" tabindex="0"
               data-post-slug="${escapeHtml(post.slug)}" style="cursor:pointer">
        <div class="post-card-background"${thumbnailStyle}></div>
        <div class="post-card-content${hasThumbnail ? ' overlay' : ''}">
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

    card.addEventListener('click', (e) => {
      if (!e.target.closest('a')) go();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  }
}
