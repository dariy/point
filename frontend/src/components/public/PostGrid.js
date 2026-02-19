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

    // One slot per post; PostCard components mounted in afterRender.
    const slots = posts.map((_, i) =>
      `<div class="post-card-slot" data-index="${i}"></div>`
    ).join('');

    return `<div class="posts-grid">${slots}</div>`;
  }

  afterRender() {
    const { posts = [], showViewCount = false } = this.props;
    posts.forEach((post, i) => {
      const slot = this.container.querySelector(`[data-index="${i}"]`);
      if (slot) {
        this.mountChild(PostCard, slot, { post, showViewCount });
      }
    });
  }
}
