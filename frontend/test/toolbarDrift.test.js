import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';

// iPad Pro 11" portrait, and the same viewport once Safari's toolbar has
// collapsed under a scroll — the pair the bug is about.
const W = 834;
const SHOWN = 1194;
const HIDDEN = 1284;

let dom;
beforeEach(() => {
  dom = setupDOM();
  window.innerWidth = W;
  window.innerHeight = SHOWN;
});
afterEach(() => dom.cleanup());

const { createDriftTracker, setupToolbarDrift, hasCollapsibleToolbar, DRIFT_VAR } =
  await import('../src/utils/toolbarDrift.js');

/** Make the media query the guard asks about answer `yes`. */
function pretendTablet() {
  const real = window.matchMedia;
  window.matchMedia = q => ({ ...real(q), matches: true });
}

const drift = () => document.documentElement.style.getPropertyValue(DRIFT_VAR);

describe('drift tracker', () => {
  test('a collapsing toolbar is drift; the toolbar coming back clears it', () => {
    const t = createDriftTracker(W, SHOWN);
    assert.equal(t.update(W, SHOWN), 0);
    assert.equal(t.update(W, HIDDEN), 90);   // toolbar gone — 90px handed back
    assert.equal(t.update(W, HIDDEN), 90);   // and it stays handed back
    assert.equal(t.update(W, SHOWN), 0);     // scrolled up, toolbar returned
  });

  test('a genuine resize is the new resting height, not drift', () => {
    const t = createDriftTracker(W, SHOWN);
    // Rotation: the width moves, so this is a viewport and not a toolbar.
    assert.equal(t.update(SHOWN, W), 0);
    assert.equal(t.update(SHOWN, W + 90), 90);   // toolbar collapses in landscape
    // A height-only change too large to be browser furniture is also genuine.
    assert.equal(t.update(SHOWN, 500), 0);
  });

  test('entering with the toolbar already collapsed self-corrects, never negative', () => {
    // A reload mid-scroll starts at the tall viewport, so the resting height
    // is not yet known.
    const t = createDriftTracker(W, HIDDEN);
    assert.equal(t.update(W, HIDDEN), 0);
    assert.equal(t.update(W, SHOWN), 0);     // toolbar reappears: the floor drops
    assert.equal(t.update(W, HIDDEN), 90);   // and now the drift is measurable
  });

  test('several toolbar-sized steps in one direction still add up to a resize', () => {
    const t = createDriftTracker(W, SHOWN);
    // The gate's reference is the last *accepted* size, so two 100px steps are
    // a 200px change and the second one is accepted as genuine.
    assert.equal(t.update(W, SHOWN - 100), 0);
    assert.equal(t.update(W, SHOWN - 200), 0);
  });
});

describe('setupToolbarDrift', () => {
  test('does nothing on a browser with no collapsing toolbar', () => {
    assert.equal(hasCollapsibleToolbar(), false);   // matchMedia stub says desktop
    const stop = setupToolbarDrift();
    window.innerHeight = HIDDEN;
    window.dispatchEvent(new Event('resize'));
    assert.equal(drift(), '');                      // rules fall back to 0px
    stop();
  });

  test('publishes the drift on :root and takes it away on cleanup', () => {
    pretendTablet();
    const stop = setupToolbarDrift();
    assert.equal(drift(), '0px');

    window.innerHeight = HIDDEN;
    window.dispatchEvent(new Event('resize'));
    assert.equal(drift(), '90px');

    window.innerHeight = SHOWN;
    window.dispatchEvent(new Event('resize'));
    assert.equal(drift(), '0px');

    stop();
    assert.equal(drift(), '');
  });

  test('cleanup unsubscribes', () => {
    pretendTablet();
    setupToolbarDrift()();
    window.innerHeight = HIDDEN;
    window.dispatchEvent(new Event('resize'));
    assert.equal(drift(), '');
  });
});
