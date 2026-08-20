import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { store } from '../src/store.js';
import {
  DEFAULT_ORDER,
  DEFAULT_PINNED,
  ORDER_STORAGE_KEY,
  PINNED_STORAGE_KEY,
  readFieldOrder,
  readPinnedFields,
  orderIndex,
  moveInOrder,
} from '../src/components/light/editorFieldLayout.js';

/** A localStorage that starts empty and can be seeded per test. */
function fakeStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('editor field layout preferences', () => {
  let savedStorage;

  beforeEach(() => {
    savedStorage = globalThis.localStorage;
    store.set('settings', undefined);
  });
  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: savedStorage, writable: true, configurable: true,
    });
    store.set('settings', undefined);
  });

  const useStorage = (seed) => Object.defineProperty(globalThis, 'localStorage', {
    value: fakeStorage(seed), writable: true, configurable: true,
  });

  describe('readFieldOrder', () => {
    test('with nothing stored, the default order', () => {
      useStorage();
      assert.deepStrictEqual(readFieldOrder(), DEFAULT_ORDER);
    });

    test('a stored order wins, and unmentioned keys follow in default order', () => {
      useStorage({ [ORDER_STORAGE_KEY]: JSON.stringify(['excerpt', 'title']) });
      const order = readFieldOrder();
      assert.deepStrictEqual(order.slice(0, 2), ['excerpt', 'title']);
      assert.deepStrictEqual(order.slice(2), DEFAULT_ORDER.filter((k) => k !== 'excerpt' && k !== 'title'));
    });

    test('account settings beat localStorage — the preference follows the user', () => {
      useStorage({ [ORDER_STORAGE_KEY]: JSON.stringify(['excerpt']) });
      store.set('settings', { editor_field_order: JSON.stringify(['slug']) });
      assert.strictEqual(readFieldOrder()[0], 'slug');
    });

    test('a malformed value falls back to the default', () => {
      useStorage({ [ORDER_STORAGE_KEY]: 'not json' });
      assert.deepStrictEqual(readFieldOrder(), DEFAULT_ORDER);
    });

    test('non-string entries are dropped', () => {
      useStorage({ [ORDER_STORAGE_KEY]: JSON.stringify(['slug', 7, null]) });
      assert.deepStrictEqual(readFieldOrder()[0], 'slug');
      assert.strictEqual(readFieldOrder().length, DEFAULT_ORDER.length);
    });

    test('a localStorage that throws is not fatal', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        value: { getItem() { throw new Error('denied'); }, setItem() {}, removeItem() {} },
        writable: true, configurable: true,
      });
      assert.deepStrictEqual(readFieldOrder(), DEFAULT_ORDER);
    });
  });

  describe('readPinnedFields', () => {
    test('with nothing stored, title and tags are on the canvas', () => {
      useStorage();
      assert.deepStrictEqual([...readPinnedFields()].sort(), [...DEFAULT_PINNED, 'content'].sort());
    });

    test('content is always on the canvas, whatever was stored', () => {
      useStorage({ [PINNED_STORAGE_KEY]: JSON.stringify(['slug']) });
      const pinned = readPinnedFields();
      assert.ok(pinned.has('content'), 'content cannot leave the canvas');
      assert.ok(pinned.has('slug'));
      assert.ok(!pinned.has('title'), 'a stored set replaces the defaults');
    });

    test('an empty set is a real choice — everything but content in Details', () => {
      useStorage({ [PINNED_STORAGE_KEY]: JSON.stringify([]) });
      assert.deepStrictEqual([...readPinnedFields()], ['content']);
    });

    test('a malformed value falls back to the defaults', () => {
      useStorage({ [PINNED_STORAGE_KEY]: '{' });
      assert.deepStrictEqual([...readPinnedFields()].sort(), [...DEFAULT_PINNED, 'content'].sort());
    });

    test('account settings beat localStorage', () => {
      useStorage({ [PINNED_STORAGE_KEY]: JSON.stringify(['slug']) });
      store.set('settings', { editor_pinned: JSON.stringify(['excerpt']) });
      assert.ok(readPinnedFields().has('excerpt'));
      assert.ok(!readPinnedFields().has('slug'));
    });
  });

  describe('orderIndex', () => {
    test('a known key gets its position', () => {
      assert.strictEqual(orderIndex(['a', 'b', 'c'], 'b'), 1);
    });

    test('a key absent from the order sorts after it, in default order', () => {
      const order = ['title'];
      assert.ok(orderIndex(order, 'slug') > orderIndex(order, 'title'));
      assert.ok(orderIndex(order, 'slug') < orderIndex(order, 'excerpt'), 'defaults keep their sequence');
    });

    test('a key in neither sorts last of all', () => {
      const order = ['title'];
      assert.ok(orderIndex(order, 'a-plugin-section') > orderIndex(order, 'instagram'));
    });
  });

  describe('moveInOrder', () => {
    test('lands the key directly after the anchor', () => {
      assert.deepStrictEqual(moveInOrder(['a', 'b', 'c', 'd'], 'd', 'a'), ['a', 'd', 'b', 'c']);
    });

    test('a null anchor means first', () => {
      assert.deepStrictEqual(moveInOrder(['a', 'b', 'c'], 'c', null), ['c', 'a', 'b']);
    });

    test('everything else keeps its relative position', () => {
      const before = ['a', 'b', 'c', 'd', 'e'];
      const after = moveInOrder(before, 'b', 'd');
      assert.deepStrictEqual(after.filter((k) => k !== 'b'), before.filter((k) => k !== 'b'));
    });

    // An anchor that is not in the order behaves like no anchor at all. Only a
    // drop onto a group that was just removed from the list could produce one,
    // and landing first is a visible, undoable result.
    test('an unknown anchor lands the key first', () => {
      assert.deepStrictEqual(moveInOrder(['a', 'b'], 'a', 'zz'), ['a', 'b']);
      assert.deepStrictEqual(moveInOrder(['a', 'b'], 'b', 'zz'), ['b', 'a']);
    });

    test('the input order is not mutated', () => {
      const before = ['a', 'b', 'c'];
      moveInOrder(before, 'c', null);
      assert.deepStrictEqual(before, ['a', 'b', 'c']);
    });
  });
});
