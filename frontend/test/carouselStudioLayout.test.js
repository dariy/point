/**
 * carousel/studio/layout.js — the studio's viewport constants.
 *
 * The two answers this module owns are both defaults-under-uncertainty: what a
 * viewport with no `matchMedia` counts as, and what a storage read that throws
 * counts as. Both are pinned here, because both are what a first visit and a
 * private window actually get.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  PROPS_PREF_KEY,
  SHEET_BREAKPOINT,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  isWideViewport,
  readPropsPref,
} from '../src/plugins/carousel/studio/layout.js';

/** A window stand-in whose media query answers whatever it is told to. */
const fakeWin = (matches) => ({ matchMedia: (q) => ({ matches: q === SHEET_BREAKPOINT && matches }) });
const fakeStore = (value) => ({ getItem: () => value });
const throwingStore = { getItem() { throw new Error('storage disabled'); } };

describe('carousel studio layout', () => {
  test('the sheet breakpoint is the admin 64em, stated wide-side', () => {
    // Mirrors `@media (max-width: 64em)` in carousel.css and the same
    // breakpoint in light/responsive.css — see the module comment.
    assert.strictEqual(SHEET_BREAKPOINT, '(min-width: 64em)');
  });

  describe('clampZoom', () => {
    test('holds the multiplier inside the range the control offers', () => {
      assert.strictEqual(clampZoom(100), ZOOM_MAX);
      assert.strictEqual(clampZoom(0.01), ZOOM_MIN);
      assert.strictEqual(clampZoom(1.5), 1.5);
    });

    test('reads anything that is not a usable multiplier as no zoom', () => {
      assert.strictEqual(clampZoom(NaN), 1);
      assert.strictEqual(clampZoom(Infinity), 1);
      assert.strictEqual(clampZoom(0), 1);
      assert.strictEqual(clampZoom(-2), 1);
      assert.strictEqual(clampZoom(undefined), 1);
    });
  });

  describe('isWideViewport', () => {
    test('asks the breakpoint when it can', () => {
      assert.strictEqual(isWideViewport(fakeWin(true)), true);
      assert.strictEqual(isWideViewport(fakeWin(false)), false);
    });

    test('is wide where there is nothing to ask — the rail needs no JS', () => {
      assert.strictEqual(isWideViewport(undefined), true);
      assert.strictEqual(isWideViewport({}), true);
    });
  });

  describe('readPropsPref', () => {
    test('opens by default: the panel holds the controls the studio is for', () => {
      assert.strictEqual(readPropsPref(fakeWin(true), fakeStore(null)), true);
    });

    test('honours a remembered close on a wide viewport', () => {
      assert.strictEqual(readPropsPref(fakeWin(true), fakeStore('0')), false);
      assert.strictEqual(readPropsPref(fakeWin(true), fakeStore('1')), true);
    });

    test('opens closed on a narrow one whatever was remembered — it is a sheet over the stage', () => {
      assert.strictEqual(readPropsPref(fakeWin(false), fakeStore('1')), false);
    });

    test('takes the default when storage is unavailable rather than throwing', () => {
      assert.strictEqual(readPropsPref(fakeWin(true), throwingStore), true);
      assert.strictEqual(readPropsPref(fakeWin(true), undefined), true);
    });

    test('the pref key is namespaced the way the editor’s is', () => {
      assert.strictEqual(PROPS_PREF_KEY, 'point:carousel:props-open');
    });
  });
});
