import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { Component } from '../src/components/Component.js';
import { html } from '../src/utils/helpers.js';

/**
 * Component.update() — the in-place render path.
 *
 * The default re-render is a rebuild, and a rebuild is a decoded image thrown
 * away. update() lets a component that can answer a change without one say so.
 * What has to be true for that to be safe is asserted here: "handled" skips the
 * rebuild AND everything wired to the DOM it preserved (cleanups, children,
 * afterRender), and anything short of an explicit `true` falls back to the
 * rebuild, so a case nobody thought about is a slow render rather than a stale
 * screen.
 */

let dom;

beforeEach(() => { dom = setupDOM(); });
afterEach(() => dom.cleanup());

/** A component recording every lifecycle step it is taken through. */
class Tracked extends Component {
  constructor(container, props) {
    super(container, props);
    this.log = [];
  }
  render() {
    this.log.push('render');
    return html`<p>${this.props.label ?? this.state.label ?? ''}</p>`;
  }
  afterRender() {
    this.log.push('afterRender');
    this.registerCleanup(() => this.log.push('cleanup'));
  }
}

function mounted(Cls, props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const c = new Cls(container, props);
  c.mount();
  c.log.length = 0;
  return c;
}

describe('Component.update', () => {
  test('is never consulted for the first render', () => {
    const container = document.createElement('div');
    const calls = [];
    class First extends Tracked {
      update(...args) { calls.push(args); return true; }
    }
    const c = new First(container, { label: 'one' });
    c.mount();

    assert.deepEqual(calls, [], 'nothing to update in place yet');
    assert.equal(container.textContent, 'one');
  });

  test('returning true skips render, afterRender and the cleanup list', () => {
    class Handled extends Tracked {
      update() {
        this.log.push('update');
        this.container.querySelector('p').textContent = this.props.label;
        return true;
      }
    }
    const c = mounted(Handled, { label: 'one' });

    c.setProps({ label: 'two' });

    assert.deepEqual(c.log, ['update'], 'no rebuild, and the old cleanups still hold');
    assert.equal(c.container.textContent, 'two');
    assert.equal(c._cleanups.length, 1, 'the render that owns the DOM keeps its resources');
  });

  test('returning false falls through to the rebuild', () => {
    class Declined extends Tracked {
      update() { this.log.push('update'); return false; }
    }
    const c = mounted(Declined, { label: 'one' });

    c.setProps({ label: 'two' });

    assert.deepEqual(c.log, ['update', 'cleanup', 'render', 'afterRender']);
    assert.equal(c.container.textContent, 'two');
  });

  test('only an exact true counts as handled', () => {
    for (const answer of [undefined, null, 1, 'true', {}]) {
      class Sloppy extends Tracked {
        update() { return answer; }
      }
      const c = mounted(Sloppy, { label: 'one' });
      c.setProps({ label: 'two' });
      assert.deepEqual(c.log, ['cleanup', 'render', 'afterRender'],
        `${String(answer)} must not be taken for a yes`);
      assert.equal(c.container.textContent, 'two');
    }
  });

  test('a component with no update() rebuilds, exactly as before', () => {
    const c = mounted(Tracked, { label: 'one' });
    c.setProps({ label: 'two' });
    assert.deepEqual(c.log, ['cleanup', 'render', 'afterRender']);
  });

  test('sees props as they were, against props as they now are', () => {
    const seen = [];
    class Diffing extends Tracked {
      update(prevProps) { seen.push([prevProps.label, this.props.label]); return true; }
    }
    const c = mounted(Diffing, { label: 'one' });
    c.setProps({ label: 'two' });
    c.setProps({ label: 'three' });
    assert.deepEqual(seen, [['one', 'two'], ['two', 'three']]);
  });

  test('sees state as it was, against state as it now is', () => {
    const seen = [];
    class Diffing extends Tracked {
      update(prevProps, prevState) { seen.push([prevState.n, this.state.n]); return true; }
    }
    const c = mounted(Diffing);
    c.setState({ n: 1 });
    c.setState({ n: 2 });
    assert.deepEqual(seen, [[undefined, 1], [1, 2]]);
  });

  test('a setState() that is handled leaves prevProps as the current props', () => {
    const seen = [];
    class Diffing extends Tracked {
      update(prevProps) { seen.push(prevProps === this.props); return true; }
    }
    const c = mounted(Diffing, { label: 'one' });
    c.setState({ n: 1 });
    assert.deepEqual(seen, [true], 'props did not change, so there is no previous copy');
  });

  test('children mounted by the preserved render are left mounted', () => {
    class Child extends Tracked {
      render() { return html`<em>child</em>`; }
    }
    class Parent extends Tracked {
      render() { return html`<p></p><div class="slot"></div>`; }
      afterRender() {
        super.afterRender();
        this.child = this.mountChild(Child, '.slot');
      }
      update() { return true; }
    }
    const c = mounted(Parent, {});
    const child = c.child;

    c.setProps({ label: 'two' });

    assert.equal(c._children.length, 1);
    assert.equal(c._children[0], child, 'not unmounted and rebuilt');
    assert.equal(child._unmounted, false);
  });

  test('unmount still tears down a component whose last render was in place', () => {
    class Handled extends Tracked {
      update() { return true; }
    }
    const c = mounted(Handled, { label: 'one' });
    c.setProps({ label: 'two' });
    c.unmount();
    assert.deepEqual(c.log, ['cleanup'], 'the surviving render released its resources');
    assert.equal(c.container.textContent, '');
  });

  test('an unmounted component is not offered the update path either', () => {
    const calls = [];
    class Handled extends Tracked {
      update() { calls.push('update'); return true; }
    }
    const c = mounted(Handled, { label: 'one' });
    c.unmount();
    c.setProps({ label: 'two' });
    assert.deepEqual(calls, []);
  });
});
