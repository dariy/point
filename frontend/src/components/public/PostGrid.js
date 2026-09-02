/**
 * PostGrid — renders a responsive grid of PostCard components.
 *
 * Props:
 *   posts          {object[]}  Array of post list items
 *   showViewCount  {boolean}   Passed through to PostCard
 *   emptyMessage   {string}    Optional text when posts is empty
 *   reversed       {boolean}   Fill right-to-left instead of left-to-right.
 *                              The home feed's scheduled ("future") pages read
 *                              outward from page 1: the post about to go live
 *                              sits top-right, next to where the newest
 *                              published post would be, and the queue runs
 *                              leftwards and down from there.
 */

import { Component } from '../Component.js';
import { PostCard } from './PostCard.js';
import { html } from '../../utils/helpers.js';
import { measureCardImageSizes } from '../../utils/gridFit.js';
import { reconcileList, setKey } from '../../utils/reconcileList.js';

export class PostGrid extends Component {
  render() {
    const { posts = [], emptyMessage = 'No posts yet.', reversed = false } = this.props;

    if (!posts.length) {
      return html`<p class="empty-state">${emptyMessage}</p>`;
    }

    // Only the first featured post gets the hero slot (grid-column: 1/-1).
    // Subsequent featured posts render as regular cards.
    const heroIndex = posts.findIndex((p) => p.is_featured);

    const slots = posts.map((_, i) => {
      const cls = i === heroIndex ? ' featured-post' : '';
      return html`<div class="post-card-slot${cls}" data-index="${i}"></div>`;
    });

    return html`<div class="posts-grid${reversed ? ' posts-grid-reversed' : ''}">${slots}</div>`;
  }

  afterRender() {
    const { posts = [] } = this.props;
    const heroIndex = posts.findIndex((p) => p.is_featured);

    // The empty tracks are already laid out, and the cards about to mount into
    // them are each about to ask how wide they will paint (PostCard reads the
    // answer back out of gridFit for its <img sizes>). Measure first, so the
    // question is asked of this grid rather than of the last one.
    measureCardImageSizes(this.$('.posts-grid'));

    this._cards = posts.map((post, i) => {
      const slot = this.$(`[data-index="${i}"]`);
      if (!slot) return null;
      // What lets the next update be a reconcile rather than a rebuild: the
      // slot is told which post it stands for, here where that is known.
      setKey(slot, post.id);
      return this.mountChild(PostCard, slot, this._cardProps(post, i === heroIndex));
    });

    const grid = this.$('.posts-grid');
    if (!grid) return;

    // Ctrl+arrows walk the cards. On document, because the grid itself is not
    // focused — and so released at the render boundary: the handler closes over
    // `grid`, and a grid from a previous render is a detached node whose cards
    // no longer exist.
    this.on(document, 'keydown', (e) => {
      if (!e.ctrlKey || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const cards = /** @type {HTMLElement[]} */ (
        Array.from(grid.querySelectorAll('.post-card[tabindex="0"]')));
      if (!cards.length) return;
      e.preventDefault();
      const idx = cards.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const delta = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      const next = idx === -1 ? 0 : Math.max(0, Math.min(idx + delta, cards.length - 1));
      cards[next].focus();
    });
  }

  _cardProps(post, isHero = false) {
    const { showViewCount = false, tagSlug, tagPage } = this.props;
    // isHero is not decoration: the hero slot spans the whole row, so its card
    // paints an image several times the width of a regular one and has to ask
    // for a different rung (PostCard → gridFit).
    return { post, showViewCount, tagSlug, tagPage, isHero };
  }

  /**
   * The in-place path for a plain `setProps({ posts })`.
   *
   * Only the list may differ: a surviving card keeps the props it was mounted
   * with, so a change to `showViewCount` or `tagSlug` has to go through the
   * rebuild or half the grid would still be showing the old answer.
   *
   * @param {object} prevProps
   * @returns {boolean} true when the grid was updated in place.
   */
  update(prevProps) {
    for (const key of new Set([...Object.keys(prevProps), ...Object.keys(this.props)])) {
      if (key !== 'posts' && prevProps[key] !== this.props[key]) return false;
    }
    return this._reconcileTo(this.props.posts || [], prevProps.posts || []);
  }

  /**
   * Update the grid in place for a new post list — the per_page refit case,
   * where the viewport now holds a different number of the same posts.
   *
   * The cards that are staying keep their DOM nodes, so their images stay
   * decoded and never repaint; a re-render would blank them for a frame (the
   * flash GridPager.finishHandoff holds a ghost to avoid) and the host page
   * would have to crossfade over it, which reads as a page change rather than
   * a resize.
   *
   * Kept as a method rather than folded into update() because the callers need
   * the answer: HomePage and SearchPage fall back to remounting the whole post
   * region when the grid cannot take the list, and setProps() would give them
   * a grid that had already rebuilt itself on the way to saying no.
   *
   * @param {object[]} posts  the refit list.
   * @returns {boolean} false when the lists diverge — caller re-renders instead.
   */
  reconcile(posts = []) {
    const handled = this._reconcileTo(posts, this.props.posts || []);
    if (handled) this.props = { ...this.props, posts };
    return handled;
  }

  /**
   * @param {object[]} posts    the list to end up showing
   * @param {object[]} current  the list currently on screen
   * @returns {boolean}
   */
  _reconcileTo(posts, current) {
    const grid = this.$('.posts-grid');
    // An empty list on either side is the empty-state markup, not a grid.
    if (!grid || !current.length || !posts.length || !this._cards) return false;
    // The hero spans a whole row, so moving it re-flows everything below it —
    // and `isHero` is a mounted prop, which a surviving card cannot be talked
    // out of. So the hero has to be the same post in the same place, not just
    // a hero in the same place: promoting a card that is already on screen
    // would leave it rendered as the regular card it was mounted as.
    const heroIndex = posts.findIndex((p) => p.is_featured);
    if (heroIndex !== current.findIndex((p) => p.is_featured)) return false;
    if (heroIndex !== -1 && posts[heroIndex].id !== current[heroIndex].id) return false;
    // Nothing in common is a different page, not an update to this one.
    // Reconciling it would be a correct grid arrived at by dissolving every
    // card and playing the arrival animation on its replacement.
    const showing = new Set(current.map((p) => p.id));
    if (!posts.some((p) => showing.has(p.id))) return false;

    // A refit follows a zoom step often enough that the shape here is not the
    // shape the surviving cards were rendered into — re-measure before the
    // arrivals read it.
    measureCardImageSizes(grid);

    /** @type {Map<string, import('./PostCard.js').PostCard>} */
    const cards = new Map();
    current.forEach((post, i) => {
      if (this._cards[i]) cards.set(String(post.id), this._cards[i]);
    });

    const { nodes } = reconcileList(grid, posts, (p) => p.id, {
      create: (post, i) => {
        const slot = document.createElement('div');
        slot.className = `post-card-slot${i === heroIndex ? ' featured-post' : ''} is-entering`;
        slot.dataset.index = String(i);
        slot.addEventListener('animationend', () => slot.classList.remove('is-entering'), { once: true });
        return slot;
      },
      // A card that survived may have moved, and afterRender() finds its slot
      // by data-index.
      update: (slot, post, i) => { slot.dataset.index = String(i); },
      remove: (slot, key) => {
        const card = cards.get(key);
        if (!card) return;
        cards.delete(key);
        card.unmount();
        const at = this._children.indexOf(card);
        if (at !== -1) this._children.splice(at, 1);
      },
    });

    // Mounted after the walk, not inside create(): PostCard measures the grid
    // it is landing in, and a slot that is not in the document yet has no
    // geometry to measure.
    this._cards = posts.map((post, i) => cards.get(String(post.id))
      ?? this.mountChild(PostCard, nodes[i], this._cardProps(post, i === heroIndex)));

    // A step that shrank the grid may have hidden cards it was about to drop;
    // whatever survived the refit belongs on screen (see .is-zoom-surplus).
    grid.querySelectorAll('.is-zoom-surplus').forEach((el) => el.classList.remove('is-zoom-surplus'));
    return true;
  }
}
