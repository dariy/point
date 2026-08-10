/**
 * tagToggleTree — the editor modal's Parents/Children pickers.
 *
 * The markup comes from renderTagToggles, so most tests build it that way
 * rather than by hand: a fixture that drifts from the real template would test
 * nothing. The hand-built ones exist to reach shapes the template cannot
 * produce — a node with no checkbox, a tree with no level-0 ancestor, a search
 * box with nothing after it — each of which is a guard in the source.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire, check } from './helpers/dom.js';
import {
  syncIndeterminate,
  filterToggleTree,
  toggleBranch,
  setupTagToggleTrees,
} from '../src/components/light/tags/tagToggleTree.js';
import { renderTagToggles } from '../src/components/light/tags/TagEditorForm.js';

const tag = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase(), parents: [], children: [], post_count: 0, ...over,
});

/** Travel > Japan > Kyoto, plus a sibling branch and a loose root. */
const FOREST = [
  tag(1, 'Travel'),
  tag(2, 'Japan', { parents: [{ id: 1 }] }),
  tag(3, 'Kyoto', { parents: [{ id: 2 }] }),
  tag(4, 'Osaka', { parents: [{ id: 2 }] }),
  tag(5, 'Food'),
  tag(6, 'Ramen', { parents: [{ id: 5 }] }),
];

describe('tagToggleTree', () => {
  let dom, root;

  /** Mount toggle markup for `selected`, wrapped the way the modal wraps it. */
  function mount(selectedIds = [], tags = FOREST) {
    root = dom.document.createElement('div');
    root.innerHTML = `
      <input type="text" class="tm-toggle-search">
      <div class="tag-toggles-container">
        ${renderTagToggles('parent_ids', tags, null, selectedIds)}
      </div>`;
    dom.document.body.appendChild(root);
    return root;
  }

  /** The checkbox for a tag, by name — ids are an implementation detail here. */
  const cbFor = name => [...root.querySelectorAll('.tag-toggle input[type="checkbox"]')]
    .find(cb => cb.closest('.tag-toggle').querySelector('span').textContent === name);

  const isHidden = el => el.classList.contains('hidden');

  /** Names of the nodes a user can actually see, in document order. */
  const visibleNames = () => [...root.querySelectorAll('.tag-toggle-node')]
    .filter(n => {
      for (let el = n; el && el !== root; el = el.parentElement) {
        if (el.classList?.contains('hidden')) return false;
      }
      return true;
    })
    .map(n => n.querySelector(':scope > .tag-toggle-row .tag-toggle span').textContent);

  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom.cleanup(); });

  // ── syncIndeterminate ──────────────────────────────────────────────────────

  describe('syncIndeterminate', () => {
    test('marks an unchecked ancestor whose descendant is checked', () => {
      mount([3]);                                  // Kyoto, two levels down
      const tree = root.querySelector('.tag-toggle-tree.level-0');
      syncIndeterminate(tree);

      assert.equal(cbFor('Kyoto').checked, true);
      assert.equal(cbFor('Kyoto').indeterminate, false, 'the checked box itself is not partial');
      assert.equal(cbFor('Japan').indeterminate, true, 'parent');
      assert.equal(cbFor('Travel').indeterminate, true, 'grandparent — reached without a level-by-level walk');
    });

    test('leaves a checked ancestor alone — checked outranks partial', () => {
      // A browser paints indeterminate OVER checked, so setting both would hide
      // the stronger of the two states.
      mount([1, 3]);
      syncIndeterminate(root.querySelector('.tag-toggle-tree.level-0'));

      assert.equal(cbFor('Travel').checked, true);
      assert.equal(cbFor('Travel').indeterminate, false);
    });

    test('clears a flag that no longer holds', () => {
      mount([3]);
      const tree = root.querySelector('.tag-toggle-tree.level-0');
      syncIndeterminate(tree);
      assert.equal(cbFor('Japan').indeterminate, true);

      cbFor('Kyoto').checked = false;
      syncIndeterminate(tree);
      assert.equal(cbFor('Japan').indeterminate, false, 'recomputed, not accumulated');
      assert.equal(cbFor('Travel').indeterminate, false);
    });

    test('leaves an unrelated branch untouched', () => {
      mount([3]);
      syncIndeterminate(root.querySelector('.tag-toggle-tree.level-0'));
      assert.equal(cbFor('Food').indeterminate, false);
      assert.equal(cbFor('Ramen').indeterminate, false);
    });

    test('a leaf is never partial, checked or not', () => {
      mount([6]);
      syncIndeterminate(root.querySelector('.tag-toggle-tree.level-0'));
      assert.equal(cbFor('Ramen').indeterminate, false, 'checked leaf');
      assert.equal(cbFor('Osaka').indeterminate, false, 'unchecked leaf');
    });

    test('skips a node carrying no checkbox of its own', () => {
      // Not reachable from the template; the guard exists so a partially
      // rendered or future node shape cannot throw here.
      root = dom.document.createElement('div');
      root.innerHTML = `
        <ul class="tag-toggle-tree level-0">
          <li class="tag-toggle-node">
            <div class="tag-toggle-row"><span>no checkbox</span></div>
            <ul class="tag-toggle-tree level-1">
              <li class="tag-toggle-node">
                <div class="tag-toggle-row">
                  <label class="tag-toggle"><input type="checkbox" checked><span>Kid</span></label>
                </div>
              </li>
            </ul>
          </li>
        </ul>`;
      assert.doesNotThrow(() => syncIndeterminate(root.querySelector('.tag-toggle-tree')));
    });
  });

  // ── filterToggleTree ───────────────────────────────────────────────────────

  describe('filterToggleTree', () => {
    let container;
    beforeEach(() => { mount(); container = root.querySelector('.tag-toggles-container'); });

    test('reveals a match and its ancestors, and nothing else', () => {
      filterToggleTree(container, 'kyoto');
      assert.deepEqual(visibleNames(), ['Travel', 'Japan', 'Kyoto']);
    });

    test('a match does not unfold its own children', () => {
      filterToggleTree(container, 'japan');
      assert.deepEqual(visibleNames(), ['Travel', 'Japan'],
        'searching finds a tag; it does not expand the subtree under it');
    });

    test('is case-insensitive and matches substrings', () => {
      filterToggleTree(container, 'KYO');
      assert.deepEqual(visibleNames(), ['Travel', 'Japan', 'Kyoto']);
    });

    test('keeps every match when several branches hit', () => {
      filterToggleTree(container, 'a');           // Travel, Japan, Osaka, Ramen
      // Roots come out name-sorted, so Food's branch precedes Travel's.
      assert.deepEqual(visibleNames(), ['Food', 'Ramen', 'Travel', 'Japan', 'Osaka']);
    });

    test('hides everything when nothing matches', () => {
      filterToggleTree(container, 'zzz');
      assert.deepEqual(visibleNames(), []);
    });

    test('an empty query restores the tree, including branches it had hidden', () => {
      filterToggleTree(container, 'kyoto');
      filterToggleTree(container, '');
      assert.deepEqual(visibleNames(), ['Food', 'Ramen', 'Travel', 'Japan', 'Kyoto', 'Osaka']);
    });

    test('whitespace counts as empty, not as a query that matches nothing', () => {
      filterToggleTree(container, '   ');
      assert.deepEqual(visibleNames(), ['Food', 'Ramen', 'Travel', 'Japan', 'Kyoto', 'Osaka']);
    });

    test('ignores a node whose label is missing', () => {
      const stray = dom.document.createElement('li');
      stray.className = 'tag-toggle-node';
      container.querySelector('.tag-toggle-tree').appendChild(stray);
      filterToggleTree(container, 'kyoto');
      assert.equal(isHidden(stray), true, 'no label, no match');
    });
  });

  // ── toggleBranch ───────────────────────────────────────────────────────────

  describe('toggleBranch', () => {
    test('opens a collapsed branch, arrow and aria-expanded with it', () => {
      mount();
      const btn = root.querySelector('[data-tt-toggle]');
      const list = root.querySelector(`#${btn.dataset.ttToggle}`);
      assert.equal(isHidden(list), true, 'starts collapsed with nothing selected below');

      toggleBranch(root, btn);
      assert.equal(isHidden(list), false);
      assert.equal(btn.getAttribute('aria-expanded'), 'true');
      assert.equal(btn.textContent, '▼');
    });

    test('shuts it again', () => {
      mount();
      const btn = root.querySelector('[data-tt-toggle]');
      const list = root.querySelector(`#${btn.dataset.ttToggle}`);
      toggleBranch(root, btn);
      toggleBranch(root, btn);
      assert.equal(isHidden(list), true);
      assert.equal(btn.getAttribute('aria-expanded'), 'false');
      assert.equal(btn.textContent, '▶');
    });

    test('does nothing when the button points at no list', () => {
      root = dom.document.createElement('div');
      root.innerHTML = `<button data-tt-toggle="missing" aria-expanded="false">▶</button>`;
      const btn = root.querySelector('button');

      assert.doesNotThrow(() => toggleBranch(root, btn));
      assert.equal(btn.getAttribute('aria-expanded'), 'false', 'no half-applied state');
      assert.equal(btn.textContent, '▶');
    });
  });

  // ── setupTagToggleTrees ────────────────────────────────────────────────────

  describe('setupTagToggleTrees', () => {
    test('computes the flags the rendered markup arrives without', () => {
      mount([3]);
      assert.equal(cbFor('Japan').indeterminate, false, 'the template sets no flags');

      setupTagToggleTrees(root);
      assert.equal(cbFor('Japan').indeterminate, true);
      assert.equal(cbFor('Travel').indeterminate, true);
    });

    test('recomputes on every change', () => {
      mount();
      setupTagToggleTrees(root);
      assert.equal(cbFor('Travel').indeterminate, false);

      check(cbFor('Kyoto'));
      assert.equal(cbFor('Travel').indeterminate, true, 'ticking a descendant marks the ancestors');

      check(cbFor('Kyoto'), false);
      assert.equal(cbFor('Travel').indeterminate, false, 'and unticking clears them');
    });

    test('wires the expand buttons', () => {
      mount();
      setupTagToggleTrees(root);
      const btn = root.querySelector('[data-tt-toggle]');
      const list = root.querySelector(`#${btn.dataset.ttToggle}`);

      click(btn);
      assert.equal(isHidden(list), false);
      click(btn);
      assert.equal(isHidden(list), true);
    });

    test('wires each search box to the container that follows it', () => {
      // The real modal renders two of these — Parents and Children. Typing in
      // one must not filter the other.
      root = dom.document.createElement('div');
      root.innerHTML = `
        <input type="text" class="tm-toggle-search" id="s-parents">
        <div class="tag-toggles-container" id="c-parents">
          ${renderTagToggles('parent_ids', FOREST, null, [])}
        </div>
        <input type="text" class="tm-toggle-search" id="s-children">
        <div class="tag-toggles-container" id="c-children">
          ${renderTagToggles('child_ids', FOREST, null, [])}
        </div>`;
      dom.document.body.appendChild(root);
      setupTagToggleTrees(root);

      const parents = root.querySelector('#c-parents');
      const children = root.querySelector('#c-children');
      const search = root.querySelector('#s-parents');
      search.value = 'kyoto';
      fire(search, 'input');

      assert.equal(parents.querySelectorAll('.tag-toggle-node.hidden').length, 3,
        'Osaka, Food and Ramen are filtered out of the Parents picker');
      assert.equal(children.querySelectorAll('.tag-toggle-node.hidden').length, 0,
        'the Children picker is untouched');
    });

    test('ignores a search box with nothing after it', () => {
      root = dom.document.createElement('div');
      root.innerHTML = `<input type="text" class="tm-toggle-search">`;
      dom.document.body.appendChild(root);

      assert.doesNotThrow(() => setupTagToggleTrees(root));
      const input = root.querySelector('.tm-toggle-search');
      input.value = 'kyoto';
      assert.doesNotThrow(() => fire(input, 'input'), 'the listener was never bound');
    });

    test('ignores a checkbox with no level-0 tree above it', () => {
      // Reachable only if a picker is rendered detached from its root list;
      // the change handler must not walk off the top of the document.
      root = dom.document.createElement('div');
      root.innerHTML = `
        <ul class="tag-toggle-tree level-1">
          <li class="tag-toggle-node">
            <div class="tag-toggle-row">
              <label class="tag-toggle"><input type="checkbox" value="9"><span>Orphan</span></label>
            </div>
          </li>
        </ul>`;
      dom.document.body.appendChild(root);
      setupTagToggleTrees(root);

      const cb = root.querySelector('input[type="checkbox"]');
      assert.doesNotThrow(() => check(cb));
      assert.equal(cb.indeterminate, false, 'nothing to recompute against');
    });

    test('binds nothing when there are no toggle trees at all', () => {
      // renderTagToggles emits a bare "No other tags available." span when the
      // tag being edited is the only one there is.
      root = dom.document.createElement('div');
      root.innerHTML = `
        <input type="text" class="tm-toggle-search">
        <div class="tag-toggles-container">${renderTagToggles('parent_ids', [tag(1, 'Only')], 1, [])}</div>`;
      dom.document.body.appendChild(root);

      assert.doesNotThrow(() => setupTagToggleTrees(root));
      assert.match(root.innerHTML, /No other tags available/);
    });
  });
});
