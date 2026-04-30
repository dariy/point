/**
 * PostGrid — renders a responsive grid of PostCard components.
 *
 * Props:
 *   posts          {object[]}  Array of post list items
 *   showViewCount  {boolean}   Passed through to PostCard
 *   emptyMessage   {string}    Optional text when posts is empty
 */

import { Component } from '../Component.js';
import { PostCard } from './PostCard.js';
import { escapeHtml } from '../../utils/helpers.js';

export class PostGrid extends Component {
  render() {
    const { posts = [], emptyMessage = 'No posts yet.' } = this.props;

    if (!posts.length) {
      return `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
    }

    // Only the first featured post gets the hero slot (grid-column: 1/-1).
    // Subsequent featured posts render as regular cards.
    const heroIndex = posts.findIndex((p) => p.is_featured);

    const slots = posts.map((_, i) => {
      const cls = i === heroIndex ? ' featured-post' : '';
      return `<div class="post-card-slot${cls}" data-index="${i}"></div>`;
    }).join('');

    return `<div class="posts-grid">${slots}</div>`;
  }

  afterRender() {
    const { posts = [], showViewCount = false, useThumbnails = true, tagSlug, tagPage } = this.props;
    const heroIndex = posts.findIndex((p) => p.is_featured);

    posts.forEach((post, i) => {
      const slot = this.container.querySelector(`[data-index="${i}"]`);
      if (slot) {
        this.mountChild(PostCard, slot, { post, showViewCount, useThumbnails, isHero: i === heroIndex, tagSlug, tagPage });
      }
    });

    const grid = this.container.querySelector('.posts-grid');
    if (!grid) return;

    this._gridKeyHandler = (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const cards = Array.from(grid.querySelectorAll('.post-card[tabindex="0"]'));
      const idx = cards.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      const next = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? idx + 1 : idx - 1;
      cards[Math.max(0, Math.min(next, cards.length - 1))]?.focus();
    };
    grid.addEventListener('keydown', this._gridKeyHandler);
  }

  beforeUnmount() {
    const grid = this.container?.querySelector('.posts-grid');
    if (grid && this._gridKeyHandler) grid.removeEventListener('keydown', this._gridKeyHandler);
  }
}
