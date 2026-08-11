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
    const { posts = [] } = this.props;
    const heroIndex = posts.findIndex((p) => p.is_featured);

    this._cards = posts.map((post, i) => {
      const slot = this.container.querySelector(`[data-index="${i}"]`);
      return slot ? this.mountChild(PostCard, slot, this._cardProps(post)) : null;
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

  _cardProps(post) {
    const { showViewCount = false, tagSlug, tagPage } = this.props;
    return { post, showViewCount, tagSlug, tagPage };
  }

  /**
   * Update the grid in place for a post list that only grew or shrank at the
   * end — the per_page refit case, where the viewport now holds a different
   * number of the same posts.
   *
   * The cards that are staying keep their DOM nodes, so their images stay
   * decoded and never repaint; a re-render would blank them for a frame (the
   * flash GridPager.finishHandoff holds a ghost to avoid) and the host page
   * would have to crossfade over it, which reads as a page change rather than
   * a resize.
   *
   * @param {object[]} posts  the refit list.
   * @returns {boolean} false when the lists diverge — caller re-renders instead.
   */
  reconcile(posts = []) {
    const current = this.props.posts || [];
    const grid = this.container.querySelector('.posts-grid');
    // An empty list on either side is the empty-state markup, not a grid.
    if (!grid || !current.length || !posts.length || !this._cards) return false;
    // The hero spans a whole row; moving it re-flows everything below, so that
    // is a re-render, not an append.
    if (posts.findIndex((p) => p.is_featured) !== current.findIndex((p) => p.is_featured)) return false;
    // Only a common prefix can be reused — anything else is a different page.
    const shared = Math.min(current.length, posts.length);
    for (let i = 0; i < shared; i++) {
      if (posts[i].id !== current[i].id) return false;
    }

    const heroIndex = posts.findIndex((p) => p.is_featured);
    for (let i = current.length - 1; i >= posts.length; i--) {
      this._dropCard(i);
    }
    for (let i = current.length; i < posts.length; i++) {
      const slot = document.createElement('div');
      slot.className = `post-card-slot${i === heroIndex ? ' featured-post' : ''} is-entering`;
      slot.dataset.index = String(i);
      slot.addEventListener('animationend', () => slot.classList.remove('is-entering'), { once: true });
      grid.appendChild(slot);
      this._cards[i] = this.mountChild(PostCard, slot, this._cardProps(posts[i]));
    }
    // A step that shrank the grid may have hidden cards it was about to drop;
    // whatever survived the refit belongs on screen (see .is-zoom-surplus).
    grid.querySelectorAll('.is-zoom-surplus').forEach((el) => el.classList.remove('is-zoom-surplus'));
    this.props = { ...this.props, posts };
    return true;
  }

  /** Unmount the card at `i` and remove its slot, keeping _children in step. */
  _dropCard(i) {
    const card = this._cards[i];
    this._cards.length = i;
    if (!card) return;
    const slot = card.container;
    card.unmount();
    const at = this._children.indexOf(card);
    if (at !== -1) this._children.splice(at, 1);
    slot.remove();
  }
}
