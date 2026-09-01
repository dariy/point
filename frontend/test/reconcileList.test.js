import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { reconcileList, setKey, KEY_ATTR } from '../src/utils/reconcileList.js';

/**
 * reconcileList — the keyed list update the in-place render path is built on.
 *
 * Two things are asserted throughout, and they are different things: that the
 * container ends up matching the list (correctness), and that the nodes which
 * were already right were not touched (the entire point — a rebuilt <img> is a
 * decoded image thrown away). The second is what `moved` and the identity
 * comparisons are for.
 */

let dom;

beforeEach(() => { dom = setupDOM(); });
afterEach(() => dom.cleanup());

/** A container already showing `keys`, as a first render would have left it. */
function showing(keys) {
  const container = document.createElement('div');
  for (const key of keys) {
    const el = document.createElement('span');
    el.textContent = String(key);
    setKey(el, key);
    container.appendChild(el);
  }
  document.body.appendChild(container);
  return container;
}

const keysOf = (container) =>
  Array.from(container.children).map((el) => el.getAttribute(KEY_ATTR));

/** The default ops: a node per item, labelled with its index. */
const ops = (log = []) => ({
  create(item, i) {
    const el = document.createElement('span');
    el.textContent = String(item);
    el.dataset.index = String(i);
    log.push(['create', item, i]);
    return el;
  },
  update(node, item, i) {
    node.dataset.index = String(i);
    log.push(['update', item, i]);
  },
  remove(node, key) { log.push(['remove', key]); },
});

describe('reconcileList', () => {
  test('an unchanged list touches nothing', () => {
    const container = showing(['a', 'b', 'c']);
    const before = Array.from(container.children);
    const log = [];

    const result = reconcileList(container, ['a', 'b', 'c'], (x) => x, ops(log));

    assert.deepEqual(keysOf(container), ['a', 'b', 'c']);
    assert.deepEqual(Array.from(container.children), before, 'same node objects');
    assert.equal(result.moved, 0);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(log.map((e) => e[0]), ['update', 'update', 'update']);
  });

  test('inserts at the end without disturbing what is already there', () => {
    const container = showing(['a', 'b']);
    const before = Array.from(container.children);

    const result = reconcileList(container, ['a', 'b', 'c', 'd'], (x) => x, ops());

    assert.deepEqual(keysOf(container), ['a', 'b', 'c', 'd']);
    assert.deepEqual(Array.from(container.children).slice(0, 2), before);
    assert.equal(result.created.length, 2);
    assert.equal(result.moved, 0);
  });

  test('inserts in the middle, moving only what has to move', () => {
    const container = showing(['a', 'c']);
    const [a, c] = Array.from(container.children);

    const result = reconcileList(container, ['a', 'b', 'c'], (x) => x, ops());

    assert.deepEqual(keysOf(container), ['a', 'b', 'c']);
    assert.equal(container.children[0], a);
    assert.equal(container.children[2], c, 'the tail kept its node');
    assert.equal(result.created.length, 1);
    assert.equal(result.moved, 0, 'an insertion is not a move of its neighbours');
  });

  test('removes from the middle without moving the survivors', () => {
    const container = showing(['a', 'b', 'c', 'd']);
    const [a, b, c, d] = Array.from(container.children);
    const log = [];

    const result = reconcileList(container, ['a', 'c', 'd'], (x) => x, ops(log));

    assert.deepEqual(keysOf(container), ['a', 'c', 'd']);
    assert.deepEqual(Array.from(container.children), [a, c, d]);
    assert.deepEqual(result.removed, [b]);
    assert.equal(b.parentNode, null, 'detached, not merely unclaimed');
    assert.equal(result.moved, 0, 'removing first is what buys this');
    // remove() runs before anything is placed, and before the node is detached.
    assert.deepEqual(log[0], ['remove', 'b']);
  });

  test('reorders by moving nodes rather than rebuilding them', () => {
    const container = showing(['a', 'b', 'c']);
    const [a, b, c] = Array.from(container.children);

    const result = reconcileList(container, ['c', 'a', 'b'], (x) => x, ops());

    assert.deepEqual(keysOf(container), ['c', 'a', 'b']);
    assert.deepEqual(Array.from(container.children), [c, a, b], 'same three nodes');
    assert.deepEqual(result.created, []);
    assert.equal(result.moved, 1, 'only c had to be lifted');
  });

  test('hands update() the new index, which is what a reorder invalidates', () => {
    const container = showing(['a', 'b', 'c']);
    reconcileList(container, ['c', 'b', 'a'], (x) => x, ops());
    assert.deepEqual(
      Array.from(container.children).map((el) => `${el.getAttribute(KEY_ATTR)}:${el.dataset.index}`),
      ['c:0', 'b:1', 'a:2'],
    );
  });

  test('a wholesale replacement removes then creates, and reports both', () => {
    const container = showing(['a', 'b']);
    const log = [];

    const result = reconcileList(container, ['x', 'y'], (x) => x, ops(log));

    assert.deepEqual(keysOf(container), ['x', 'y']);
    assert.equal(result.created.length, 2);
    assert.equal(result.removed.length, 2);
    assert.deepEqual(log.filter((e) => e[0] === 'update'), []);
  });

  test('an empty list empties the container', () => {
    const container = showing(['a', 'b']);
    const result = reconcileList(container, [], (x) => x, ops());
    assert.equal(container.children.length, 0);
    assert.equal(result.removed.length, 2);
    assert.deepEqual(result.nodes, []);
  });

  test('nodes comes back in list order, whatever the DOM did', () => {
    const container = showing(['a', 'b']);
    const result = reconcileList(container, ['b', 'z', 'a'], (x) => x, ops());
    assert.deepEqual(result.nodes.map((el) => el.getAttribute(KEY_ATTR)), ['b', 'z', 'a']);
    assert.deepEqual(result.nodes, Array.from(container.children));
  });

  test('leaves an unkeyed child alone — it belongs to something else', () => {
    const container = showing(['a']);
    const foreign = document.createElement('p');
    foreign.className = 'empty-state';
    container.appendChild(foreign);

    reconcileList(container, ['a', 'b'], (x) => x, ops());

    assert.ok(container.contains(foreign), 'not removed');
    assert.deepEqual(keysOf(container).filter(Boolean), ['a', 'b']);
  });

  test('a duplicate key throws rather than silently losing a node', () => {
    const container = showing(['a']);
    assert.throws(
      () => reconcileList(container, ['a', 'a'], (x) => x, ops()),
      /duplicate key "a"/,
    );
  });

  test('keys are compared as strings, so 1 and "1" are the same item', () => {
    const container = document.createElement('div');
    const el = document.createElement('span');
    setKey(el, 1);
    container.appendChild(el);

    const result = reconcileList(container, [{ id: 1 }], (x) => x.id, ops());
    assert.deepEqual(result.created, []);
    assert.equal(container.children[0], el);
  });

  test('update and remove are optional', () => {
    const container = showing(['a', 'b']);
    reconcileList(container, ['b', 'c'], (x) => x, {
      create: (item) => {
        const el = document.createElement('span');
        el.textContent = String(item);
        return el;
      },
    });
    assert.deepEqual(keysOf(container), ['b', 'c']);
  });

  test('create is not optional', () => {
    assert.throws(() => reconcileList(showing([]), ['a'], (x) => x, {}), /ops.create is required/);
    assert.throws(() => reconcileList(null, [], (x) => x, ops()), /no container/);
  });
});
