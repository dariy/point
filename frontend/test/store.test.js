/**
 * Store — the two "nothing happened" guards, and merge().
 *
 * Every subscriber of a store key is, in practice, a component that answers by
 * calling setState(), and setState() destroys and rebuilds its whole subtree.
 * That makes a notification for a write that changed nothing the most
 * expensive no-op in the frontend, and it is the cost these three pieces exist
 * to remove:
 *
 *   set()                — drops a write of the value already there
 *   subscribeSelector()  — wakes a subscriber only for the slice it reads
 *   merge()              — keeps a key's object identity when a patch is a
 *                          no-op, so set()'s guard can fire on a re-fetch
 *
 * The last one is the load-bearing part: the settings payload is rebuilt from
 * JSON on every page fetch, so it is never reference-equal to the settings
 * already in the store and the Object.is guard alone would never fire on the
 * key that is written most.
 *
 * These tests count callbacks, because a wasted repaint is only ever visible
 * as a call that should not have happened.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { store } from '../src/store.js';
import { Component } from '../src/components/Component.js';
import { html } from '../src/utils/helpers.js';

/** A subscriber that records what it was called with. */
const spy = () => {
  const fn = (...args) => { fn.calls.push(args); };
  fn.calls = [];
  return fn;
};

/** A key no other test touches — the store is a process-wide singleton. */
let n = 0;
const freshKey = () => `test_key_${process.pid}_${n++}`;

describe('Store.set — the equality guard', () => {
  test('notifies when the value changes', () => {
    const key = freshKey();
    const seen = spy();
    store.subscribe(key, seen);

    store.set(key, 'a');
    store.set(key, 'b');

    assert.deepEqual(seen.calls, [['a'], ['b']]);
  });

  test('does not notify when the value is the one already there', () => {
    const key = freshKey();
    const seen = spy();
    store.subscribe(key, seen);

    store.set(key, 'a');
    store.set(key, 'a');
    store.set(key, 'a');

    assert.equal(seen.calls.length, 1, 'two repeat writes, no extra dispatch');
  });

  test('the first write of a key always notifies, undefined included', () => {
    const key = freshKey();
    const seen = spy();
    store.subscribe(key, seen);

    // `_state[key]` reads undefined for an absent key, so an absent key and a
    // key holding undefined are indistinguishable by value alone.
    store.set(key, undefined);
    assert.equal(seen.calls.length, 1, 'absent is not the same as set-to-undefined');

    store.set(key, undefined);
    assert.equal(seen.calls.length, 1, 'now it is a repeat write');
  });

  test('holds the same reference, so an in-place mutation is invisible', () => {
    const key = freshKey();
    const value = { a: 1 };
    store.set(key, value);

    const seen = spy();
    store.subscribe(key, seen);
    value.a = 2;
    store.set(key, value);

    assert.equal(seen.calls.length, 0, 'same reference — write a new object instead');
  });

  test('still notifies for a fresh object with equal contents', () => {
    const key = freshKey();
    const seen = spy();
    store.subscribe(key, seen);

    store.set(key, { a: 1 });
    store.set(key, { a: 1 });

    // Object.is is reference equality; this is exactly the gap merge() fills.
    assert.equal(seen.calls.length, 2);
  });

  test('a dropped write leaves the stored value alone', () => {
    const key = freshKey();
    store.set(key, 7);
    store.set(key, 7);
    assert.equal(store.get(key), 7);
  });
});

describe('Store.merge', () => {
  test('a patch that changes nothing neither writes nor notifies', () => {
    const key = freshKey();
    const original = { blog_title: 'Point', posts_per_page: 12 };
    store.set(key, original);

    const seen = spy();
    store.subscribe(key, seen);
    store.merge(key, { blog_title: 'Point', posts_per_page: 12 });

    assert.equal(seen.calls.length, 0, 'no dispatch');
    assert.equal(store.get(key), original, 'and the identity is preserved');
  });

  test('a patch that changes one value notifies with the merged object', () => {
    const key = freshKey();
    store.set(key, { blog_title: 'Point', posts_per_page: 12 });

    const seen = spy();
    store.subscribe(key, seen);
    store.merge(key, { blog_title: 'Somewhere' });

    assert.equal(seen.calls.length, 1);
    assert.deepEqual(store.get(key), { blog_title: 'Somewhere', posts_per_page: 12 });
  });

  test('a patch that adds a key notifies, even with every old value intact', () => {
    const key = freshKey();
    store.set(key, { a: 1 });

    const seen = spy();
    store.subscribe(key, seen);
    store.merge(key, { b: 2 });

    assert.equal(seen.calls.length, 1);
    assert.deepEqual(store.get(key), { a: 1, b: 2 });
  });

  test('merging into an unset key seeds it', () => {
    const key = freshKey();
    const seen = spy();
    store.subscribe(key, seen);

    store.merge(key, { a: 1 });

    assert.equal(seen.calls.length, 1);
    assert.deepEqual(store.get(key), { a: 1 });
  });

  test('a re-fetch of unchanged settings is free', () => {
    const key = freshKey();
    // What a page load does: parse the payload afresh, merge it in.
    const payload = () => JSON.parse('{"blog_title":"Point","show_tags":true}');
    store.merge(key, payload());

    const seen = spy();
    store.subscribe(key, seen);
    for (let i = 0; i < 5; i++) store.merge(key, payload());

    assert.equal(seen.calls.length, 0, 'five identical fetches, no repaint');
  });
});

describe('Store.subscribeSelector', () => {
  test('fires only when the selected slice changes', () => {
    const key = freshKey();
    store.set(key, { blog_title: 'Point', posts_per_page: 12 });

    const seen = spy();
    store.subscribeSelector(key, (s) => s.blog_title, seen);

    store.merge(key, { posts_per_page: 24 });
    assert.equal(seen.calls.length, 0, 'an unrelated setting is not our business');

    store.merge(key, { blog_title: 'Somewhere' });
    assert.deepEqual(seen.calls, [['Somewhere', { blog_title: 'Somewhere', posts_per_page: 24 }]]);
  });

  test('does not fire on subscribe — the current slice is the baseline', () => {
    const key = freshKey();
    store.set(key, { a: 1 });

    const seen = spy();
    store.subscribeSelector(key, (s) => s.a, seen);

    assert.equal(seen.calls.length, 0);
    store.set(key, { a: 1 });
    assert.equal(seen.calls.length, 0, 'a new object with the same slice is still no change');
  });

  test('tolerates a key that has never been written', () => {
    const key = freshKey();
    const seen = spy();
    store.subscribeSelector(key, (s) => s?.a, seen);

    store.set(key, { a: 1 });

    assert.deepEqual(seen.calls[0][0], 1);
  });

  test('unsubscribes', () => {
    const key = freshKey();
    store.set(key, { a: 1 });
    const seen = spy();
    const unsub = store.subscribeSelector(key, (s) => s.a, seen);

    unsub();
    store.merge(key, { a: 2 });

    assert.equal(seen.calls.length, 0);
  });
});

describe('Component.subscribeStoreSelector', () => {
  let dom;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom.cleanup(); });

  /**
   * An `on*Selector`-shaped subscriber for a probe key.
   *
   * subscribeStoreSelector() takes one of store.js's accessors, not a store
   * and a string key; this test is about how long the subscription lives, not
   * about any real key, so it binds a throwaway one in the same shape.
   */
  const onKeySelector = key => (select, cb) => store.subscribeSelector(key, select, cb);

  test('is released and retaken per render, like subscribeStore', () => {
    const key = freshKey();
    store.set(key, { title: 'Point', other: 1 });
    const seen = spy();

    class C extends Component {
      render() { return html`<p>x</p>`; }
      afterRender() {
        this.subscribeStoreSelector(onKeySelector(key), (s) => s.title, seen);
      }
    }

    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    const c = new C(el);
    c.mount();

    for (let i = 0; i < 5; i++) c.setState({ i });
    assert.equal(store._listeners[key].size, 1, 'one subscription, however many renders');

    store.merge(key, { other: 2 });
    assert.equal(seen.calls.length, 0, 'and the slice it watches did not move');

    c.unmount();
    assert.equal(store._listeners[key].size, 0, 'released on unmount');
  });
});
