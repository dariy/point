/**
 * Component — auto-released resources and data-action delegation.
 *
 * registerCleanup() already made "release what this render acquired" possible
 * (frontend/test/componentCleanup.test.js). It did not make it short: every
 * listener still cost a stored handler, a matching removeEventListener and the
 * discipline to write both. 542 addEventListener calls in frontend/src against
 * 113 removeEventListener is what that discipline actually produced.
 *
 * on()/timer()/interval()/observe()/raf() fold the acquisition into the
 * registration so the safe form is the short one, and an `actions` map moves
 * click wiring to one delegated listener on the container — which, unlike
 * everything inside it, survives the render (p-frontend-rendering-m06x.1).
 *
 * These tests count listeners and timers rather than trusting the shape of the
 * code, because a leak is only ever visible as a number that keeps going up.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire } from './helpers/dom.js';
import { Component } from '../src/components/Component.js';
import { html } from '../src/utils/helpers.js';

describe('Component — auto-released resources', () => {
  let dom;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom.cleanup(); });

  const mountIn = (Cls, props) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    const c = new Cls(el, props);
    c.mount();
    return c;
  };

  /**
   * An EventTarget that counts. linkedom's own add/remove work, but they do not
   * report a balance, and the balance is the entire assertion here.
   */
  const counter = () => ({
    live: 0,
    calls: [],
    addEventListener(type, fn, opts) { this.live++; this.calls.push(['add', type, opts]); },
    removeEventListener(type, fn, opts) { this.live--; this.calls.push(['remove', type, opts]); },
  });

  describe('on()', () => {
    test('a listener taken per render is held once, however many re-renders', () => {
      const target = counter();
      class C extends Component {
        render() { return html`<p>x</p>`; }
        afterRender() { this.on(target, 'keydown', () => {}); }
      }

      const c = mountIn(C);
      assert.equal(target.live, 1, 'one after mount');
      for (let i = 0; i < 6; i++) c.setState({ i });
      assert.equal(target.live, 1, 'still one after six re-renders');

      c.unmount();
      assert.equal(target.live, 0, 'and none after unmount');
    });

    test('options are passed to both add and remove, so a capture listener detaches', () => {
      const target = counter();
      const opts = { capture: true, passive: true };
      class C extends Component {
        render() { return html`<p>x</p>`; }
        afterRender() { this.on(target, 'touchstart', () => {}, opts); }
      }

      mountIn(C).unmount();
      assert.deepEqual(target.calls, [
        ['add', 'touchstart', opts],
        ['remove', 'touchstart', opts],
      ]);
    });

    test('a missing target is a no-op, so a conditional element needs no guard', () => {
      class C extends Component {
        render() { return html`<p>x</p>`; }
        afterRender() { this.result = this.on(this.$('.absent'), 'click', () => {}); }
      }
      const c = mountIn(C);
      assert.equal(c.result, null);
    });

    test('the listener really fires, and really stops firing', () => {
      let fired = 0;
      class C extends Component {
        render() { return html`<button id="b">go</button>`; }
        afterRender() { this.on(this.$('#b'), 'click', () => { fired++; }); }
      }

      const c = mountIn(C);
      click(c.$('#b'));
      assert.equal(fired, 1);

      // The button from the previous render is gone from the tree but still
      // reachable; its listener must have been removed with it.
      const stale = c.$('#b');
      c.setState({ n: 1 });
      click(stale);
      assert.equal(fired, 1, 'the previous render\'s listener is detached');

      click(c.$('#b'));
      assert.equal(fired, 2, 'the current one is attached');
    });
  });

  describe('timer() / interval()', () => {
    test('a pending timeout is cancelled by the next render', () => {
      let fired = 0;
      class C extends Component {
        render() { return html`<p>x</p>`; }
        afterRender() { this.timer(() => { fired++; }, 1); }
      }

      const c = mountIn(C);
      c.setState({ a: 1 });
      c.setState({ a: 2 });
      c.unmount();

      return new Promise(resolve => setTimeout(() => {
        assert.equal(fired, 0, 'no render\'s timeout outlived it');
        resolve();
      }, 20));
    });

    test('a timeout that already fired is still safe to clean up', () => {
      let fired = 0;
      class C extends Component {
        render() { return html`<p>x</p>`; }
        afterRender() { this.timer(() => { fired++; }, 0); }
      }

      const c = mountIn(C);
      return new Promise(resolve => setTimeout(() => {
        assert.equal(fired, 1);
        c.setState({ a: 1 });   // clearTimeout on a spent id
        c.unmount();
        resolve();
      }, 20));
    });

    test('an interval stops at unmount instead of running forever', () => {
      let ticks = 0;
      class C extends Component {
        render() { return html`<p>x</p>`; }
        afterRender() { this.interval(() => { ticks++; }, 1); }
      }

      const c = mountIn(C);
      return new Promise(resolve => setTimeout(() => {
        c.unmount();
        const atUnmount = ticks;
        assert.ok(atUnmount > 0, 'it ran at all');
        setTimeout(() => {
          assert.equal(ticks, atUnmount, 'and not once more after unmount');
          resolve();
        }, 20);
      }, 20));
    });
  });

  describe('observe()', () => {
    test('one observer per render, disconnected as the next one arrives', () => {
      class C extends Component {
        render() { return html`<div class="panel"></div>`; }
        afterRender() {
          this.observe(new ResizeObserver(() => {})).observe(this.$('.panel'));
        }
      }

      const c = mountIn(C);
      for (let i = 0; i < 4; i++) c.setState({ i });

      const made = ResizeObserver.observers;
      assert.equal(made.length, 5, 'one constructed per render');
      assert.equal(made.filter(o => !o.disconnected).length, 1, 'only the newest is live');

      c.unmount();
      assert.equal(made.filter(o => !o.disconnected).length, 0);
    });

    test('it returns the observer, so the call chains', () => {
      const c = new (class extends Component { render() { return html``; } })(
        dom.document.createElement('div'),
      );
      const ro = new ResizeObserver(() => {});
      assert.equal(c.observe(ro), ro);
    });
  });

  describe('raf()', () => {
    test('a frame scheduled by the previous render cannot run against the new DOM', () => {
      // The harness runs requestAnimationFrame synchronously, so cancellation
      // has to be observed through the ids handed to cancelAnimationFrame.
      const cancelled = [];
      let next = 1;
      const pending = new Map();
      globalThis.requestAnimationFrame = fn => { const id = next++; pending.set(id, fn); return id; };
      globalThis.cancelAnimationFrame = id => { cancelled.push(id); pending.delete(id); };

      class C extends Component {
        render() { return html`<p>x</p>`; }
        afterRender() { this.raf(() => {}); }
      }

      const c = mountIn(C);
      c.setState({ a: 1 });
      c.setState({ a: 2 });
      assert.deepEqual(cancelled, [1, 2], 'each render cancelled its predecessor\'s frame');

      c.unmount();
      assert.deepEqual(cancelled, [1, 2, 3], 'and unmount cancelled the last');
      assert.equal(pending.size, 0);
    });
  });
});

describe('Component — data-action delegation', () => {
  let dom;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom.cleanup(); });

  const mountIn = (Cls, props) => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    const c = new Cls(el, props);
    c.mount();
    return c;
  };

  class List extends Component {
    constructor(container, props) {
      super(container, props);
      this.log = [];
      this.actions = {
        remove(e, el) { this.log.push(['remove', el.dataset.id]); },
        add() { this.log.push(['add']); },
        'change:pick'(e, el) { this.log.push(['pick', el.value]); },
      };
    }
    render() {
      return html`
        <button data-action="add">Add</button>
        <button data-action="remove" data-id="7"><span class="icon">x</span></button>
        <select data-action="pick"><option value="a">a</option></select>
        <button>inert</button>
      `;
    }
  }

  test('a click on a [data-action] element runs its handler, bound to the component', () => {
    const c = mountIn(List);
    click(c.$('[data-action="add"]'));
    assert.deepEqual(c.log, [['add']]);
  });

  test('the handler receives the [data-action] element even when the click lands inside it', () => {
    const c = mountIn(List);
    click(c.$('.icon'));
    assert.deepEqual(c.log, [['remove', '7']]);
  });

  test('a click on nothing in particular is ignored', () => {
    const c = mountIn(List);
    click(c.$('button:last-of-type'));
    click(c.container);
    assert.deepEqual(c.log, []);
  });

  test('a non-click type is delegated by writing it into the key', () => {
    const c = mountIn(List);
    const select = c.$('[data-action="pick"]');
    fire(select, 'change');
    assert.deepEqual(c.log, [['pick', 'a']]);

    // The bare-key rule is click-only: a `change` must not reach `add`.
    fire(c.$('[data-action="add"]'), 'change');
    assert.equal(c.log.length, 1);
  });

  test('the binding survives re-renders — one listener, never re-attached', () => {
    const c = mountIn(List);
    for (let i = 0; i < 5; i++) c.setState({ i });

    click(c.$('[data-action="add"]'));
    assert.deepEqual(c.log, [['add']], 'attached exactly once, and still attached');
  });

  test('unmount() releases the delegated listener', () => {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    const c = new List(el, {});
    c.mount();
    c.unmount();

    // The container survives unmount (only its contents are cleared), so a
    // stray event on it is exactly what a leaked delegate would answer.
    const btn = dom.document.createElement('button');
    btn.setAttribute('data-action', 'add');
    el.appendChild(btn);
    click(btn);
    assert.deepEqual(c.log, []);
  });

  test('an event inside a mounted child belongs to the child alone', () => {
    class Child extends Component {
      constructor(container, props) {
        super(container, props);
        this.actions = { add() { this.props.log.push(['child-add']); } };
      }
      render() { return html`<button data-action="add">child</button>`; }
    }
    class Parent extends Component {
      constructor(container, props) {
        super(container, props);
        this.log = [];
        this.actions = { add() { this.log.push(['parent-add']); } };
      }
      render() { return html`<div id="slot"></div><button data-action="add">parent</button>`; }
      afterRender() { this.mountChild(Child, '#slot', { log: this.log }); }
    }

    const c = mountIn(Parent);
    click(c.$('#slot button'));
    assert.deepEqual(c.log, [['child-add']], 'the parent did not answer it too');

    click(c.$('#slot').nextElementSibling);
    assert.deepEqual(c.log, [['child-add'], ['parent-add']]);
  });

  test('a component with no actions map binds nothing', () => {
    class Plain extends Component {
      render() { return html`<button data-action="add">x</button>`; }
    }
    const c = mountIn(Plain);
    assert.equal(c._actionTeardowns.length, 0);
    click(c.$('[data-action]'));   // must not throw
  });
});
