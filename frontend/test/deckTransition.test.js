/**
 * deckTransition.js — pure geometry + DOM primitives behind the carousel
 * deck's panoramic pan (p-cl69). No component involved; MediaViewer.test.js
 * covers the wiring into an actual drag/step.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';
import {
  imgEl,
  computeDeckGeometry,
  applyDeckClip,
  clearDeckClip,
  setImgTranslateX,
  clearImgTransform,
} from '../src/utils/deckTransition.js';

describe('deckTransition', () => {
  let dom;

  beforeEach(() => {
    dom = setupDOM();
    dom.window.innerWidth = 800;
  });

  afterEach(() => {
    dom.cleanup();
  });

  /** A `.carousel-slide`-shaped element with a rendered image of `width`px. */
  function slideWithImg(width) {
    const slide = dom.document.createElement('div');
    const img = dom.document.createElement('img');
    img.className = 'immersive-bg-image';
    img.getBoundingClientRect = () => ({ width });
    slide.appendChild(img);
    return slide;
  }

  describe('imgEl', () => {
    test('returns the slide\'s rendered image', () => {
      const slide = slideWithImg(400);
      assert.strictEqual(imgEl(slide), slide.querySelector('img'));
    });
    test('returns null for a slide with no image, or no slide', () => {
      assert.strictEqual(imgEl(dom.document.createElement('div')), null);
      assert.strictEqual(imgEl(null), null);
    });
  });

  describe('computeDeckGeometry', () => {
    test('equal widths -> imgW/marginW/viewportW', () => {
      const geo = computeDeckGeometry(slideWithImg(400), slideWithImg(400));
      assert.deepStrictEqual(geo, { imgW: 400, marginW: 200, viewportW: 800 });
    });

    test('widths within the 1px tolerance still engage', () => {
      const geo = computeDeckGeometry(slideWithImg(400), slideWithImg(400.5));
      assert.ok(geo);
    });

    test('unequal widths beyond tolerance -> null (legacy fallback)', () => {
      assert.strictEqual(computeDeckGeometry(slideWithImg(400), slideWithImg(300)), null);
    });

    test('missing <img> on either side -> null', () => {
      const withImg = slideWithImg(400);
      const noImg = dom.document.createElement('div');
      assert.strictEqual(computeDeckGeometry(withImg, noImg), null);
      assert.strictEqual(computeDeckGeometry(noImg, withImg), null);
    });

    test('zero-width image -> null (avoids a degenerate clip)', () => {
      assert.strictEqual(computeDeckGeometry(slideWithImg(0), slideWithImg(0)), null);
    });

    test('image as wide as the viewport -> zero margin, still engages', () => {
      const geo = computeDeckGeometry(slideWithImg(800), slideWithImg(800));
      assert.deepStrictEqual(geo, { imgW: 800, marginW: 0, viewportW: 800 });
    });
  });

  describe('applyDeckClip / clearDeckClip', () => {
    test('set and remove clip-path on every slide in the list', () => {
      const a = slideWithImg(400);
      const b = slideWithImg(400);
      applyDeckClip([a, b], 200);
      assert.strictEqual(a.style.clipPath, 'inset(0 200px)');
      assert.strictEqual(b.style.clipPath, 'inset(0 200px)');
      clearDeckClip([a, b]);
      assert.strictEqual(a.style.clipPath, '');
      assert.strictEqual(b.style.clipPath, '');
    });

    test('tolerate a null slide in the list', () => {
      assert.doesNotThrow(() => applyDeckClip([null], 200));
      assert.doesNotThrow(() => clearDeckClip([null]));
    });
  });

  describe('setImgTranslateX / clearImgTransform', () => {
    test('move and reset the inner image independent of the slide box', () => {
      const slide = slideWithImg(400);
      const img = imgEl(slide);
      setImgTranslateX(slide, 120, { transition: 'transform 0.3s ease' });
      assert.strictEqual(img.style.transform, 'translateX(120px)');
      assert.strictEqual(img.style.transition, 'transform 0.3s ease');
      assert.strictEqual(slide.style.transform, '');

      setImgTranslateX(slide, 0);
      assert.strictEqual(img.style.transform, '');

      clearImgTransform(slide);
      assert.strictEqual(img.style.transition, '');
    });

    test('tolerate a slide with no image', () => {
      const slide = dom.document.createElement('div');
      assert.doesNotThrow(() => setImgTranslateX(slide, 100));
      assert.doesNotThrow(() => clearImgTransform(slide));
    });
  });
});
