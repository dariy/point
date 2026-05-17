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
      if (!e.ctrlKey || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const cards = Array.from(grid.querySelectorAll('.post-card[tabindex="0"]'));
      if (!cards.length) return;
      e.preventDefault();
      const idx = cards.indexOf(document.activeElement);
      const delta = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      const next = idx === -1 ? 0 : Math.max(0, Math.min(idx + delta, cards.length - 1));
      cards[next].focus();
    };
    document.addEventListener('keydown', this._gridKeyHandler);
  }

  beforeUnmount() {
    if (this._gridKeyHandler) document.removeEventListener('keydown', this._gridKeyHandler);
  }
}
