/**
 * carousel/studio/history.js — the undo/redo ring over the carousel document.
 *
 * The ring exists because the document is immutable by construction: every
 * writer in `document.js` returns a new document, so the previous state is
 * simply the previous reference. These pin the three things that cannot be read
 * off that sentence — that an *equal* document is dropped rather than recorded
 * (several studio writers deliberately return one when a value is rejected),
 * that a push after an undo abandons the redo tail, and that the limit evicts
 * from the old end rather than refusing new work.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createHistory } from '../src/plugins/carousel/studio/history.js';
import { normalizeDocument, splitDocument } from '../src/plugins/carousel/document.js';

/** A document with `n` slides off one source — the studio's own starting shape. */
function doc(n, patch = {}) {
  return normalizeDocument({
    ...splitDocument({ source: '/2026/08/wide.jpg', n, aspect: '4:5' }),
    ...patch,
  });
}

describe('carousel studio history', () => {
  test('a fresh ring has nothing to undo or redo', () => {
    const h = createHistory();
    assert.equal(h.canUndo, false);
    assert.equal(h.canRedo, false);
    assert.equal(h.undo(), null);
    assert.equal(h.redo(), null);
  });

  test('reset makes one document the floor — there is no step before it', () => {
    const h = createHistory();
    h.reset(doc(3));
    assert.equal(h.depth, 1);
    assert.equal(h.canUndo, false, 'the loaded document is not an edit');
    assert.equal(h.undo(), null);
  });

  test('undo hands back the previous document, redo the one after it', () => {
    const a = doc(3);
    const b = doc(4);
    const c = doc(5);
    const h = createHistory();
    h.reset(a);
    h.push(b);
    h.push(c);

    assert.equal(h.canUndo, true);
    assert.equal(h.canRedo, false);
    assert.strictEqual(h.undo(), b, 'the same reference back, not a copy');
    assert.strictEqual(h.undo(), a);
    assert.equal(h.canUndo, false);
    assert.strictEqual(h.redo(), b);
    assert.strictEqual(h.redo(), c);
    assert.equal(h.canRedo, false);
  });

  test('pushing the same reference twice records one step', () => {
    const a = doc(3);
    const b = doc(4);
    const h = createHistory();
    h.reset(a);
    assert.equal(h.push(b), true);
    assert.equal(h.push(b), false, 'deduped by reference');
    assert.equal(h.depth, 2);
  });

  test('pushing an equal-but-new document records nothing', () => {
    // This is the case the studio actually produces: a writer that clamped its
    // input back to where it started still returns a fresh object.
    const h = createHistory();
    h.reset(doc(3));
    assert.equal(h.push(doc(3)), false, 'equal content is not a step');
    assert.equal(h.depth, 1);
    assert.equal(h.canUndo, false);
  });

  test('a push after an undo abandons the redo tail', () => {
    const a = doc(3);
    const b = doc(4);
    const c = doc(5);
    const h = createHistory();
    h.reset(a);
    h.push(b);
    h.undo();
    assert.equal(h.canRedo, true);

    h.push(c);
    assert.equal(h.canRedo, false, 'b is gone — c took its place');
    assert.strictEqual(h.undo(), a);
    assert.strictEqual(h.redo(), c);
  });

  test('the limit evicts the oldest document, keeping the newest work', () => {
    const h = createHistory({ limit: 3 });
    h.reset(doc(2));
    h.push(doc(3));
    h.push(doc(4));
    h.push(doc(5));
    assert.equal(h.depth, 3);
    assert.equal(h.undo().slides.length, 4);
    assert.equal(h.undo().slides.length, 3);
    assert.equal(h.canUndo, false, 'the 2-slide document fell off the old end');
  });

  test('a nonsense limit falls back to a usable one rather than to zero', () => {
    const h = createHistory({ limit: 0 });
    h.reset(doc(3));
    h.push(doc(4));
    assert.equal(h.canUndo, true);
  });

  test('replace swaps the current entry without adding a step', () => {
    // What a render does: it stamps `rendered` blocks onto the document already
    // on screen, which is not an edit — but the entry has to carry them, or
    // undoing the next edit would come back to a document that re-encodes
    // every slide.
    const a = doc(3);
    const b = doc(4);
    const rendered = doc(4, { aspect: '1:1' });
    const h = createHistory();
    h.reset(a);
    h.push(b);
    h.replace(rendered);

    assert.equal(h.depth, 2, 'no new step');
    assert.equal(h.canRedo, false);
    assert.strictEqual(h.undo(), a);
    assert.strictEqual(h.redo(), rendered, 'the replacement, not what it replaced');
  });

  test('push on an empty ring seeds it rather than dropping the document', () => {
    const h = createHistory();
    const a = doc(3);
    assert.equal(h.push(a), true);
    assert.equal(h.depth, 1);
    assert.equal(h.canUndo, false);
  });
});
