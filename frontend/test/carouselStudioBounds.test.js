/**
 * carousel/studio/bounds.js — the studio's slide-count range.
 *
 * The whole point of the module is that the state owner and the markup agree
 * on one range, so these pin the numbers themselves (a silent widening would
 * let the count slider offer a value `updateSplit` refuses) and the clamp's
 * three edges: below, above, and the floor that keeps a slider's float count
 * an integer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  MIN_SLIDES,
  MAX_SLIDES,
  DEFAULT_SLIDES,
  clampSlides,
} from '../src/plugins/carousel/studio/bounds.js';

describe('carousel studio bounds', () => {
  test('the range is 2..20, defaulting to 3', () => {
    assert.strictEqual(MIN_SLIDES, 2);
    assert.strictEqual(MAX_SLIDES, 20);
    assert.strictEqual(DEFAULT_SLIDES, 3);
  });

  test('clampSlides pulls counts below the floor up to it', () => {
    assert.strictEqual(clampSlides(1), MIN_SLIDES);
    assert.strictEqual(clampSlides(-5), MIN_SLIDES);
    assert.strictEqual(clampSlides(0), MIN_SLIDES);
  });

  test('clampSlides pulls counts above the ceiling down to it', () => {
    assert.strictEqual(clampSlides(21), MAX_SLIDES);
    assert.strictEqual(clampSlides(100), MAX_SLIDES);
  });

  test('clampSlides floors a fractional count and passes the bounds through', () => {
    assert.strictEqual(clampSlides(5.9), 5);
    assert.strictEqual(clampSlides(MIN_SLIDES), MIN_SLIDES);
    assert.strictEqual(clampSlides(MAX_SLIDES), MAX_SLIDES);
  });
});
