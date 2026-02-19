/**
 * PostCard — a single post entry in the grid.
 *
 * Props:
 *   post           {object}   Post list item from the API
 *   showViewCount  {boolean}  Show view count if true (from settings.show_view_counts)
 */

import { Component } from '../Component.js';
import { escapeHtml, safeUrl } from '../../utils/helpers.js';
import { formatDateShort } from '../../utils/formatters.js';

export class PostCard extends Component {
  render() {
    const { post, showViewCount = false } = this.props;
    if (!post) return '';

    const hasThumbnail = !!post.thumbnail_path;
    const cardClass = [
      'post-card',
      hasThumbnail ? 'has-image' : 'text-only',
      post.is_featured ? 'featured-post' : '',
    ].filter(Boolean).join(' ');

    const thumbnailStyle = hasThumbnail
      ? ` style="background-image: url('${safeUrl(post.thumbnail_path)}')"` : '';

    const tags = (post.tags || []).slice(0, 3).map((t) =>
      `<a href="/tag/${escapeHtml(typeof t === 'string' ? t : t.slug)}" class="tag-link">${escapeHtml(typeof t === 'string' ? t : t.name)}</a>`
    ).join('');

    const viewCount = showViewCount && post.view_count != null
      ? `<span class="view-count" aria-label="${escapeHtml(String(post.view_count))} views">
           ${escapeHtml(String(post.view_count))} views
         </span>`
      : '';

    const featured = post.is_featured
      ? `<span class="featured-badge" aria-label="Featured">Featured</span>` : '';

    return `
      <article class="${cardClass}">
        <a href="/post/${escapeHtml(post.slug)}" class="post-card-link" tabindex="-1" aria-hidden="true">
          <div class="post-card-background"${thumbnailStyle}></div>
        </a>
        <div class="post-card-content${hasThumbnail ? ' overlay' : ''}">
          ${featured}
          <h2 class="post-card-title">
            <a href="/post/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a>
          </h2>
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
}
