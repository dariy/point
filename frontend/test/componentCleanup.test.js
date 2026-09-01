// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
/**
 * Component — resources acquired in afterRender() last exactly one render.
 *
 * afterRender() runs again on every setState(), and for a long time nothing
 * released what the previous pass had taken. Only unmount() released anything,
 * and only one render's worth of it, so every observer, subscription and
 * listener a component acquired accumulated once per re-render for the life of
 * the document (p-frontend-rendering-m06x.8).
 *
 * The visible symptom was not memory. Each leaked `offline_status` /
 * `autosave_status` subscription closed over the SAME live admin page, so one
 * status update re-ran updateSyncPill() once per leaked copy — removing and
 * re-inserting .sync-pill in the live header N times, N growing with how long
 * the tab had been open.
 *
 * These tests count. A counted stub stands in for ResizeObserver, since
 * linkedom has none and the harness one already records disconnect(); the
 * store's own listener set is counted directly.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { Component } from '../src/components/Component.js';
import { html } from '../src/utils/helpers.js';
import { store } from '../src/store.js';

/** Live subscribers on a store key — the leak, measured at its source. */
const listeners = key => store._listeners[key]?.size ?? 0;

describe('Component — per-render cleanup', () => {
  let dom;

  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom.cleanup(); });

  /** A component that takes one resource per render and reports the balance. */
  class Acquirer extends Component {
    constructor(container, props) {
      super(container, props);
      this.acquired = 0;
      this.released = 0;
    }
    render() { return html`<p>x</p>`; }
    afterRender() {
      this.acquired++;
      this.registerCleanup(() => { this.released++; });
    }
    get live() { return this.acquired - this.released; }
  }

  const mountIn = (Cls, props) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    const c = new Cls(el, props);
    c.mount();
    return c;
  };

  test('a resource taken in afterRender() is held once, however many re-renders', () => {
    const c = mountIn(Acquirer);
    assert.equal(c.live, 1, 'one after mount');

    for (let i = 0; i < 6; i++) c.setState({ i });

    assert.equal(c.acquired, 7, 'afterRender ran once per render');
    assert.equal(c.live, 1, 'and only the newest is still held');
  });

  test('setProps() releases the previous render too', () => {
    const c = mountIn(Acquirer);
    c.setProps({ a: 1 });
    c.setProps({ a: 2 });
    assert.equal(c.live, 1);
  });

  test('unmount() releases the last render', () => {
    const c = mountIn(Acquirer);
    c.setState({ a: 1 });
    c.unmount();
    assert.equal(c.live, 0, 'nothing left holding');
    assert.equal(c.released, 2, 'both renders released, neither twice');
  });

  test('a cleanup that throws does not strand the ones behind it', () => {
    let tail = 0;
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args);

    class Angry extends Component {
      render() { return html``; }
      afterRender() {
        this.registerCleanup(() => { throw new Error('boom'); });
        this.registerCleanup(() => { tail++; });
      }
    }
    try {
      const c = mountIn(Angry);
      c.setState({ a: 1 });
      assert.equal(tail, 1, 'the cleanup after the thrower still ran');
      c.unmount();
      assert.equal(tail, 2);
    } finally {
      console.error = realError;
    }
    assert.equal(errors.length, 2, 'and each failure was reported, not swallowed');
  });

  test('registerCleanup ignores a non-function, so a helper may return nothing', () => {
    class Loose extends Component {
      render() { return html``; }
      afterRender() {
        this.registerCleanup(undefined);
        this.registerCleanup(null);
      }
    }
    const c = mountIn(Loose);
    assert.doesNotThrow(() => c.setState({ a: 1 }));
    assert.doesNotThrow(() => c.unmount());
  });

  test('subscribeStore() from afterRender() does not accumulate', () => {
    const KEY = 'cleanup_probe';
    let fired = 0;
    class Subscriber extends Component {
      render() { return html``; }
      afterRender() { this.subscribeStore(store, KEY, () => { fired++; }); }
    }
    const before = listeners(KEY);
    const c = mountIn(Subscriber);
    for (let i = 0; i < 5; i++) c.setState({ i });
    assert.equal(listeners(KEY), before + 1, 'still one subscription after six renders');

    store.set(KEY, 1);
    assert.equal(fired, 1, 'and one notification runs the callback once');

    c.unmount();
    assert.equal(listeners(KEY), before, 'unmount takes it back down');
  });

  test('a subscriber that re-renders on notify terminates', () => {
    // Re-rendering releases this render's subscription and takes a fresh one.
    // Dispatching over the live Set would visit the replacement — and its
    // replacement, and so on — so store.set() iterates a snapshot instead.
    const KEY = 'cleanup_reentrant';
    let renders = 0;
    class Reactive extends Component {
      render() { renders++; return html``; }
      afterRender() { this.subscribeStore(store, KEY, () => this._rerender()); }
    }
    const c = mountIn(Reactive);
    renders = 0;

    store.set(KEY, 1);
    assert.equal(renders, 1, 'exactly one re-render, not an unbounded chain');

    store.set(KEY, 2);
    assert.equal(renders, 2, 'and the fresh subscription is still live');
    c.unmount();
  });

  test('a callback unsubscribed mid-dispatch by an earlier one is not called', () => {
    const KEY = 'cleanup_sibling';
    const seen = [];
    class Parent extends Component {
      render() { return html`<div id="slot"></div>`; }
      afterRender() {
        this.subscribeStore(store, KEY, () => { seen.push('parent'); this.setState({}); });
        this.mountChild(Child, '#slot');
      }
    }
    class Child extends Component {
      render() { return html``; }
      afterRender() { this.subscribeStore(store, KEY, () => seen.push('child')); }
    }
    const c = mountIn(Parent);
    assert.equal(listeners(KEY), 2, 'parent and child both subscribed');

    store.set(KEY, 1);
    // The parent's re-render unmounts the child, which drops the child's
    // subscription before the dispatch reaches it.
    assert.deepEqual(seen, ['parent'], 'the dead child was skipped, not called');
    assert.equal(listeners(KEY), 2, 'and the rebuilt pair replaced it');
    c.unmount();
    assert.equal(listeners(KEY), 0);
  });
});

describe('setupAdminLayout — the leak it caused', () => {
  let dom, page, TagsManagerPage;

  const settle = () => new Promise(r => setImmediate(r));
  const liveObservers = () =>
    globalThis.ResizeObserver.observers.filter(o => !o.disconnected).length;

  beforeEach(async () => {
    dom = setupDOM('<!doctype html><html><body></body></html>', { path: '/light/tags' });
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ tags: [], total: 0 }),
    });
    store.set('user', { username: 'tester' });
    ({ default: TagsManagerPage } = await import('../src/pages/light/TagsManagerPage.js'));

    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new TagsManagerPage(el, {});
    page.mount();
    await settle();
  });

  afterEach(() => {
    page?.unmount();
    page = null;
    delete globalThis.fetch;
    dom.cleanup();
  });

  test('re-rendering an admin page does not accumulate header observers', async () => {
    const baseline = liveObservers();
    assert.ok(baseline >= 1, 'the header compact observer is running');

    for (let i = 0; i < 6; i++) {
      page.setState({ filter: `probe-${i}` });
      await settle();
    }

    assert.equal(liveObservers(), baseline,
      'one observer per live header, not one per setState');
  });

  test('re-rendering an admin page does not accumulate sync-pill subscriptions', async () => {
    const offline = listeners('offline_status');
    const autosave = listeners('autosave_status');

    for (let i = 0; i < 6; i++) {
      page.setState({ filter: `probe-${i}` });
      await settle();
    }

    assert.equal(listeners('offline_status'), offline, 'offline_status held once');
    assert.equal(listeners('autosave_status'), autosave, 'autosave_status held once');
  });

  test('one status update inserts exactly one sync pill', async () => {
    for (let i = 0; i < 4; i++) {
      page.setState({ filter: `probe-${i}` });
      await settle();
    }

    store.set('autosave_status', { status: 'saving' });
    assert.equal(page.container.querySelectorAll('.sync-pill').length, 1,
      'the header was rewritten once, not once per leaked subscription');

    store.set('autosave_status', {});
  });

  test('unmounting an admin page disconnects its header observer', async () => {
    const before = liveObservers();
    page.unmount();
    page = null;
    assert.equal(liveObservers(), before - 1);
  });
});
