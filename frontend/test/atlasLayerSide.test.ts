import { test, describe } from 'node:test';
import assert from 'node:assert';

import { atlasSide, onAtlasSide, watchAtlasSide, ATLAS_SIDE_ATTR, type AtlasSideEnv } from '../src/plugins/tags-atlas/atlasLayerLayout.ts';

function fakeBody() {
  const attrs = new Map<string, string>();
  return {
    hasAttribute: (n: string) => attrs.has(n),
    setAttribute: (n: string, v: string) => { attrs.set(n, v); },
    removeAttribute: (n: string) => { attrs.delete(n); },
  } as unknown as HTMLElement;
}

function fakeEnv(fine: boolean, landscape: boolean) {
  const state = { fine, landscape, fn: null as (() => void) | null, stopped: false };
  const env: AtlasSideEnv = {
    fine: () => state.fine,
    landscape: () => state.landscape,
    observe(fn) {
      state.fn = fn;
      return () => { state.stopped = true; };
    },
  };
  return { env, state };
}

describe('atlasSide', () => {
  test('is true only for touch in landscape', () => {
    assert.equal(atlasSide({ fine: () => false, landscape: () => true }), true);
    assert.equal(atlasSide({ fine: () => false, landscape: () => false }), false);
    assert.equal(atlasSide({ fine: () => true, landscape: () => true }), false);
    assert.equal(atlasSide({ fine: () => true, landscape: () => false }), false);
  });
});

describe('watchAtlasSide', () => {
  test('sets the attribute at once for touch in landscape', () => {
    const body = fakeBody();
    const { env } = fakeEnv(false, true);
    watchAtlasSide(body, env);
    assert.equal(body.hasAttribute(ATLAS_SIDE_ATTR), true);
  });

  test('a rotation moves the attribute both ways', () => {
    const body = fakeBody();
    const { env, state } = fakeEnv(false, false);
    watchAtlasSide(body, env);
    assert.equal(body.hasAttribute(ATLAS_SIDE_ATTR), false);
    state.landscape = true;
    state.fn!();
    assert.equal(body.hasAttribute(ATLAS_SIDE_ATTR), true);
    state.landscape = false;
    state.fn!();
    assert.equal(body.hasAttribute(ATLAS_SIDE_ATTR), false);
  });

  test('a mouse removes the attribute, a touch sets it again', () => {
    const body = fakeBody();
    const { env, state } = fakeEnv(false, true);
    watchAtlasSide(body, env);
    state.fine = true;
    state.fn!();
    assert.equal(body.hasAttribute(ATLAS_SIDE_ATTR), false);
    state.fine = false;
    state.fn!();
    assert.equal(body.hasAttribute(ATLAS_SIDE_ATTR), true);
  });

  test('the stop removes the attribute and the observers', () => {
    const body = fakeBody();
    const { env, state } = fakeEnv(false, true);
    const stop = watchAtlasSide(body, env);
    stop();
    assert.equal(body.hasAttribute(ATLAS_SIDE_ATTR), false);
    assert.equal(state.stopped, true);
  });
});

describe('onAtlasSide', () => {
  test('calls back at once, then only on a change', () => {
    const { env, state } = fakeEnv(false, true);
    const calls: boolean[] = [];
    const stop = onAtlasSide((side) => calls.push(side), env);
    assert.deepEqual(calls, [true]);
    state.fn!();
    assert.deepEqual(calls, [true], 'no change, no call');
    state.landscape = false;
    state.fn!();
    state.landscape = true;
    state.fn!();
    assert.deepEqual(calls, [true, false, true]);
    stop();
    assert.equal(state.stopped, true);
  });
});
