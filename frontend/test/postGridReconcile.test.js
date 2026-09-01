// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { setKey } from '../src/utils/reconcileList.js';

/**
 * PostGrid.reconcile — the in-place update a per_page refit uses.
 *
 * A refit is a resize of the view, not a move to another one: the cards on
 * screen stay, and only the tail of the list changes. Re-rendering the grid for
 * that blanked every card for a frame while its image re-decoded, which the
 * host page then had to crossfade over — the "blink like turning a page" a zoom
 * step used to produce. reconcile keeps the surviving cards' DOM nodes and
 * moves, appends or drops the difference, and refuses (returns false, caller
 * re-renders) when the change is one it cannot make without a rebuild.
 *
 * It is reconcileList() underneath now, so the arbitrary insert / remove /
 * reorder cases are covered there; what is asserted here is the grid's own
 * decisions — what it refuses, what it re-measures, and that the surviving
 * PostCards keep both their nodes and their place in _children.
 */

let PostGrid;
let dom;

before(async () => { ({ PostGrid } = await import('../src/components/public/PostGrid.js')); });
beforeEach(() => { dom = setupDOM(); });
afterEach(() => dom.cleanup());

/** A grid already showing `posts`, without running the real mount path. */
function gridShowing(posts) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const grid = document.createElement('div');
  grid.className = 'posts-grid';
  if (posts.length) container.appendChild(grid);

  const g = Object.create(PostGrid.prototype);
  g.container = container;
  g.props = { posts };
  g._children = [];
  // Appending is the one path that mounts a real child; stub it out so the test
  // stays about the reconcile decision rather than PostCard's markup.
  g.mountChild = (Cls, target, props) => {
    const card = { container: target, props, unmounted: false, unmount() { this.unmounted = true; } };
    g._children.push(card);
    return card;
  };

  const heroIndex = posts.findIndex((p) => p.is_featured);
  g._cards = posts.map((post, i) => {
    const slot = document.createElement('div');
    slot.className = `post-card-slot${i === heroIndex ? ' featured-post' : ''}`;
    slot.dataset.index = String(i);
    setKey(slot, post.id);
    grid.appendChild(slot);
    return g.mountChild(null, slot, { post });
  });
  return { grid, g };
}

const P = (...ids) => ids.map((id) => ({ id }));
const idsIn = (grid) => Array.from(grid.children).map((el) => el.dataset.rkey);

describe('PostGrid.reconcile', () => {
  test('appends the posts a wider fit added, leaving the existing cards alone', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    const before = Array.from(grid.children);

    assert.equal(g.reconcile(P(1, 2, 3, 4, 5)), true);
    assert.equal(grid.children.length, 5);
    // The first three nodes are the same objects — never re-rendered, so their
    // images never repaint.
    assert.deepEqual(Array.from(grid.children).slice(0, 3), before);
    assert.equal(g.props.posts.length, 5);
    assert.ok(grid.children[3].classList.contains('is-entering'));
    assert.ok(grid.children[4].classList.contains('is-entering'));
  });

  test('drops the posts a narrower fit no longer holds, unmounting their cards', () => {
    const { grid, g } = gridShowing(P(1, 2, 3, 4, 5));
    const dropped = g._cards.slice(3);

    assert.equal(g.reconcile(P(1, 2, 3)), true);
    assert.equal(grid.children.length, 3);
    assert.deepEqual(dropped.map((c) => c.unmounted), [true, true]);
    assert.equal(g._children.length, 3, 'unmounted cards leave the child list');
    assert.equal(g._cards.length, 3);
    assert.equal(g.props.posts.length, 3);
  });

  test('clears the surplus marks a zoom step left on cards that did fit', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    grid.children[2].classList.add('is-zoom-surplus');

    assert.equal(g.reconcile(P(1, 2, 3, 4)), true);
    assert.equal(grid.children[2].classList.contains('is-zoom-surplus'), false);
  });

  test('keeps data-index true for a card the change moved', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    const third = grid.children[2];

    assert.equal(g.reconcile(P(2, 3)), true);
    assert.deepEqual(idsIn(grid), ['2', '3']);
    assert.equal(third.dataset.index, '1', 'afterRender finds slots by data-index');
    assert.equal(g._cards.length, 2);
  });

  test('a middle removal keeps the cards on either side of it', () => {
    const { grid, g } = gridShowing(P(1, 2, 3, 4));
    const [first, , , fourth] = Array.from(grid.children);

    assert.equal(g.reconcile(P(1, 3, 4)), true);
    assert.deepEqual(idsIn(grid), ['1', '3', '4']);
    assert.equal(grid.children[0], first);
    assert.equal(grid.children[2], fourth);
    assert.equal(g._children.length, 3);
  });

  test('refuses a list with nothing in common — that is another page', () => {
    assert.equal(gridShowing(P(1, 2, 3)).g.reconcile(P(7, 8, 9)), false);
    assert.equal(gridShowing(P(1, 2, 3)).g.reconcile([]), false, 'empty state, not a grid');
    assert.equal(gridShowing([]).g.reconcile(P(1, 2)), false, 'no grid to reconcile into');
  });

  test('refuses a list that moves the hero, since it re-flows the whole grid', () => {
    const { g } = gridShowing([{ id: 1 }, { id: 2, is_featured: true }]);
    assert.equal(g.reconcile([{ id: 1, is_featured: true }, { id: 2 }]), false);
  });

  test('refuses to promote a card that is already on screen to the hero slot', () => {
    // Same hero INDEX, different hero post: card 2 would keep the regular-card
    // markup and isHero=false it was mounted with.
    const { g } = gridShowing([{ id: 1, is_featured: true }, { id: 2 }]);
    assert.equal(g.reconcile([{ id: 2, is_featured: true }, { id: 1 }]), false);
  });

  test('an unchanged list is a no-op that still reports success', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    const before = Array.from(grid.children);
    assert.equal(g.reconcile(P(1, 2, 3)), true);
    assert.deepEqual(Array.from(grid.children), before);
  });

  test('update() takes the same path for a plain setProps({ posts })', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    g.props = { ...g.props, posts: P(1, 2, 3, 4) };

    assert.equal(g.update({ posts: P(1, 2, 3) }), true);
    assert.equal(grid.children.length, 4);
  });

  test('update() declines when anything other than the list changed', () => {
    // A surviving card keeps the props it was mounted with, so showViewCount
    // would be true for the arrivals and stale for everyone else.
    const { g } = gridShowing(P(1, 2, 3));
    g.props = { ...g.props, posts: P(1, 2, 3, 4), showViewCount: true };

    assert.equal(g.update({ posts: P(1, 2, 3), showViewCount: false }), false);
  });
});
