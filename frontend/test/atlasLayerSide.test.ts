import { test, describe } from 'node:test';
import assert from 'node:assert';

import { atlasSide, onAtlasSide, settledCall, watchAtlasSide, ATLAS_SIDE_ATTR, SIDE_SETTLE_MS, type AtlasSideEnv, type SettleClock } from '../src/plugins/tags-atlas/atlasLayerLayout.ts';

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

describe('settledCall', () => {
  /** A clock that runs its jobs on demand: frames in order, timers by time. */
  function fakeClock() {
    let frames: (() => void)[] = [];
    let timers: { ms: number; fn: () => void }[] = [];
    const clock: SettleClock = {
      frame(fn) { frames.push(fn); return () => { frames = frames.filter((f) => f !== fn); }; },
      after(ms, fn) { const t = { ms, fn }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
    };
    const nextFrame = () => { const run = frames; frames = []; for (const f of run) f(); };
    const runTimers = () => { const run = timers; timers = []; for (const t of run) t.fn(); };
    return { clock, nextFrame, runTimers, pending: () => frames.length + timers.length, timers: () => timers };
  }

  test('reads the verdict again after two frames and after the settle time', () => {
    // A rotation on iOS: the event comes while the query still says landscape.
    const { env, state } = fakeEnv(false, true);
    const seen: boolean[] = [];
    const c = fakeClock();
    let late: ReturnType<typeof settledCall> | null = null;
    onAtlasSide((side) => seen.push(side), {
      ...env,
      observe(fn) { late = settledCall(fn, c.clock); return env.observe(late.call); },
    });
    assert.deepEqual(seen, [true]);
    state.fn!(); // the event, with the old viewport
    assert.deepEqual(seen, [true], 'no change yet');
    assert.equal(c.timers()[0]!.ms, SIDE_SETTLE_MS);
    state.landscape = false; // the viewport settles
    c.nextFrame();
    assert.deepEqual(seen, [true], 'one frame is not enough');
    c.nextFrame();
    assert.deepEqual(seen, [true, false], 'portrait after two frames');
    c.runTimers();
    assert.deepEqual(seen, [true, false], 'no second call for the same verdict');

    // And back to landscape, read only by the late timer.
    state.fn!();
    c.nextFrame();
    c.nextFrame();
    state.landscape = true;
    c.runTimers();
    assert.deepEqual(seen, [true, false, true], 'landscape after the settle time');
  });

  test('stop cancels the late calls', () => {
    let n = 0;
    const c = fakeClock();
    const late = settledCall(() => { n++; }, c.clock);
    late.call();
    assert.equal(n, 1);
    late.stop();
    assert.equal(c.pending(), 0);
  });
});
