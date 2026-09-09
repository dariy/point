/**
 * carousel/studio/preview.js — the live preview, written as CSS.
 *
 * These functions are the studio's only DOM writes for framing, and they hold
 * no state: they take the elements and the numbers. So the tests hand them
 * plain `{ style: {} }` stand-ins and read the properties back — which is also
 * what pins the two things the module exists to get right: the crop reproduced
 * as `background-size`/`background-position` (so the preview cannot lie about
 * the render), and the source path set from JS and URI-encoded, so a media
 * path with a quote in it cannot break out of the `url()`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { paintDeckSlide, paintSplit } from '../src/plugins/carousel/studio/preview.js';

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const el = () => ({ style: {} });

describe('carousel studio preview', () => {
  describe('paintDeckSlide', () => {
    test('an untouched crop fills the frame at 100%', () => {
      const img = el();
      const bg = el();
      paintDeckSlide(
        { imgs: [img], bgs: [bg] },
        {
          slide: { source: 'test.jpg', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );

      assert.strictEqual(img.style.backgroundImage, 'url("test.jpg")');
      assert.strictEqual(img.style.backgroundSize, '100% 100%');
      assert.strictEqual(img.style.backgroundPosition, '0% 0%');
      assert.strictEqual(img.style.backgroundRepeat, 'no-repeat');
    });

    test('a half-width crop is a 200% background — the zoom the render will apply', () => {
      const img = el();
      paintDeckSlide(
        { imgs: [img], bgs: [el()] },
        {
          slide: {
            source: 'a.jpg',
            crop: { x: 0.5, y: 0, w: 0.5, h: 1 },
            fit: 'cover',
            bg: null,
          },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(img.style.backgroundSize, '200% 200%');
      assert.strictEqual(img.style.backgroundPosition, '100% 50%');
    });

    test('every element showing the slide is painted, stage slice and filmstrip frame alike', () => {
      const stageImg = el();
      const stripImg = el();
      paintDeckSlide(
        { imgs: [stageImg, stripImg], bgs: [] },
        {
          slide: { source: 'a.jpg', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(stageImg.style.backgroundImage, stripImg.style.backgroundImage);
      assert.strictEqual(stageImg.style.backgroundSize, stripImg.style.backgroundSize);
    });

    test('a source path is URI-encoded, so a quote cannot break out of the url()', () => {
      const img = el();
      paintDeckSlide(
        { imgs: [img], bgs: [] },
        {
          slide: { source: '/media/a"); evil.jpg', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(img.style.backgroundImage, 'url("/media/a%22);%20evil.jpg")');
    });

    test('a slide with no source paints no image at all', () => {
      const img = el();
      paintDeckSlide(
        { imgs: [img], bgs: [] },
        {
          slide: { source: '', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(img.style.backgroundImage, 'none');
    });
  });

  describe('the fill layer behind a deck slide', () => {
    const paintBg = (slideBg, hasPad) => {
      const bg = el();
      paintDeckSlide(
        { imgs: [], bgs: [bg] },
        {
          slide: {
            source: 'a.jpg',
            crop: { x: 0, y: 0, w: 1, h: 0.5 },
            fit: 'contain',
            bg: slideBg,
          },
          srcW: 2000,
          srcH: 1000,
          aspect: '1:1',
          hasPad,
        },
      );
      return bg.style;
    };

    test('a slide with no letterbox keeps the layer empty, so the hatch shows through', () => {
      const style = paintBg({ type: 'solid', color: '#ff0000' }, false);
      assert.strictEqual(style.backgroundImage, 'none');
      assert.strictEqual(style.backgroundColor, 'transparent');
      assert.strictEqual(style.filter, 'none');
    });

    test('a solid fill is a background colour', () => {
      const style = paintBg({ type: 'solid', color: '#ff0000' }, true);
      assert.strictEqual(style.backgroundColor, '#ff0000');
      assert.strictEqual(style.backgroundImage, 'none');
    });

    test('a gradient is literal CSS, in the same angle convention the canvas uses', () => {
      const style = paintBg(
        {
          type: 'gradient',
          angle: 45,
          stops: [
            { at: 0, color: '#000000' },
            { at: 1, color: '#ffffff' },
          ],
        },
        true,
      );
      assert.strictEqual(
        style.backgroundImage,
        'linear-gradient(45deg, #000000 0%, #ffffff 100%)',
      );
      assert.strictEqual(style.backgroundColor, 'transparent');
    });

    test('blur is the slide\'s own image, reusing its numbers and blurred in cqw', () => {
      const style = paintBg(null, true);
      assert.strictEqual(style.backgroundImage, 'url("a.jpg")');
      assert.match(style.filter, /^blur\([\d.]+cqw\)$/);
      assert.ok(style.backgroundSize && style.backgroundSize !== '100% 100%');
    });
  });

  describe('paintSplit', () => {
    test('the stage and every frame carry the source over the pad hatch', () => {
      const stage = el();
      const frames = [el(), el()];
      paintSplit(
        { stage, frames },
        {
          source: 'split.jpg',
          srcW: 2000,
          srcH: 1000,
          aspect: '1:1',
          anchorY: 0.5,
          n: 2,
          strategy: 'cover',
        },
      );

      for (const target of [stage, ...frames]) {
        assert.match(target.style.backgroundImage, /^url\("split\.jpg"\), repeating-linear-gradient/);
        assert.strictEqual(target.style.backgroundRepeat, 'no-repeat, no-repeat');
        assert.match(target.style.backgroundSize, /^[\d.]+% [\d.]+%, 100% 100%$/);
      }
    });

    test('each frame shows its own slice — frame 2 is offset from frame 1', () => {
      const frames = [el(), el()];
      paintSplit(
        { stage: null, frames },
        {
          source: 'split.jpg',
          srcW: 2000,
          srcH: 1000,
          aspect: '1:1',
          anchorY: 0.5,
          n: 2,
          strategy: 'cover',
        },
      );
      assert.notStrictEqual(frames[0].style.backgroundPosition, frames[1].style.backgroundPosition);
    });

    test('a missing stage is not an error — the caller may render only a filmstrip', () => {
      const frames = [el()];
      assert.doesNotThrow(() =>
        paintSplit(
          { stage: null, frames },
          {
            source: 'a.jpg',
            srcW: 1000,
            srcH: 1000,
            aspect: '1:1',
            anchorY: 0.5,
            n: 1,
            strategy: 'cover',
          },
        ),
      );
      assert.match(frames[0].style.backgroundImage, /url\("a\.jpg"\)/);
    });

    test('before the probe resolves the stage falls back to its CSS default and the frames stretch', () => {
      const stage = el();
      const frames = [el(), el()];
      paintSplit(
        { stage, frames },
        {
          source: 'a.jpg',
          srcW: null,
          srcH: null,
          aspect: '1:1',
          anchorY: 0.5,
          n: 2,
          strategy: 'cover',
        },
      );
      assert.strictEqual(stage.style.backgroundImage, 'url("a.jpg")');
      assert.strictEqual(stage.style.backgroundSize, undefined, 'no crop to compute yet');
      assert.strictEqual(frames[0].style.backgroundSize, '200% 100%, 100% 100%');
      assert.strictEqual(frames[0].style.backgroundPosition, '0% 50%, 0% 0%');
      assert.strictEqual(frames[1].style.backgroundPosition, '100% 50%, 0% 0%');
    });
  });
});
