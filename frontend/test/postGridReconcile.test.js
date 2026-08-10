import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

/**
 * PostGrid.reconcile — the in-place update a per_page refit uses.
 *
 * A refit is a resize of the view, not a move to another one: the cards on
 * screen stay, and only the tail of the list changes. Re-rendering the grid for
 * that blanked every card for a frame while its image re-decoded, which the
 * host page then had to crossfade over — the "blink like turning a page" a zoom
 * step used to produce. reconcile keeps the shared prefix's DOM nodes and only
 * appends or drops the difference, and refuses (returns false, caller
 * re-renders) whenever the two lists are not the same list at two lengths.
 *
 * No jsdom in the repo — the same element stubs as gridPager.test.js.
 */

let PostGrid;

function makeEl(className = '') {
  const el = {
    dataset: {},
    children: [],
    parentElement: null,
    style: {},
    textContent: '',
    innerHTML: '',
    classList: {
      _set: new Set(),
      add(...cs) { for (const c of cs) this._set.add(c); },
      remove(...cs) { for (const c of cs) this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { if (on) this.add(c); else this.remove(c); },
    },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    remove() {
      const p = this.parentElement;
      if (p) p.children = p.children.filter((c) => c !== this);
      this.parentElement = null;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    querySelector(sel) { return sel === '.posts-grid' ? el._grid : null; },
    querySelectorAll(sel) {
      const want = sel.replace('.', '');
      return el.children.filter((c) => c.classList.contains(want));
    },
  };
  // className and classList are two views of one thing in the DOM; the stub has
  // to keep them in step or a slot built by assigning className looks classless.
  Object.defineProperty(el, 'className', {
    get: () => [...el.classList._set].join(' '),
    set: (v) => { el.classList._set = new Set(String(v).split(' ').filter(Boolean)); },
  });
  el.className = className;
  return el;
}

/** A grid already showing `posts`, without running the real mount path. */
function gridShowing(posts) {
  const container = makeEl();
  const grid = makeEl('posts-grid');
  container._grid = grid;

  const g = Object.create(PostGrid.prototype);
  g.container = container;
  g.props = { posts };
  g._children = [];
  g._cards = posts.map((_, i) => {
    const slot = makeEl('post-card-slot');
    slot.dataset.index = String(i);
    grid.appendChild(slot);
    const card = { container: slot, unmounted: false, unmount() { this.unmounted = true; } };
    g._children.push(card);
    return card;
  });
  // Appending is the one path that mounts a real child; stub it out so the test
  // stays about the reconcile decision rather than PostCard's markup.
  g.mountChild = (Cls, target) => {
    const card = { container: target, unmount() {} };
    g._children.push(card);
    return card;
  };
  return { grid, g };
}

const P = (...ids) => ids.map((id) => ({ id }));

describe('PostGrid.reconcile', () => {
  before(async () => {
    global.document = { createElement: () => makeEl() };
    ({ PostGrid } = await import('../src/components/public/PostGrid.js'));
  });

  test('appends the posts a wider fit added, leaving the existing cards alone', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    const before = grid.children.slice();

    assert.equal(g.reconcile(P(1, 2, 3, 4, 5)), true);
    assert.equal(grid.children.length, 5);
    // The first three nodes are the same objects — never re-rendered, so their
    // images never repaint.
    assert.deepEqual(grid.children.slice(0, 3), before);
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
    assert.equal(g.props.posts.length, 3);
  });

  test('clears the surplus marks a zoom step left on cards that did fit', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    grid.children[2].classList.add('is-zoom-surplus');

    assert.equal(g.reconcile(P(1, 2, 3, 4)), true);
    assert.equal(grid.children[2].classList.contains('is-zoom-surplus'), false);
  });

  test('refuses a list that is not the same one at another length', () => {
    assert.equal(gridShowing(P(1, 2, 3)).g.reconcile(P(9, 2, 3)), false, 'different first post');
    assert.equal(gridShowing(P(1, 2, 3)).g.reconcile([]), false, 'empty state, not a grid');
    assert.equal(gridShowing([]).g.reconcile(P(1, 2)), false, 'no grid to reconcile into');
  });

  test('refuses a list that moves the hero, since it re-flows the whole grid', () => {
    const { g } = gridShowing([{ id: 1 }, { id: 2, is_featured: true }]);
    assert.equal(g.reconcile([{ id: 1, is_featured: true }, { id: 2 }]), false);
  });

  test('an unchanged list is a no-op that still reports success', () => {
    const { grid, g } = gridShowing(P(1, 2, 3));
    assert.equal(g.reconcile(P(1, 2, 3)), true);
    assert.equal(grid.children.length, 3);
  });
});
