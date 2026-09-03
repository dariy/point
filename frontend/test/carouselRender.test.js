/**
 * carousel/render.js — the draw layer.
 *
 * render.js issues no measurements of its own (all from geometry.js) and
 * touches nothing real: decode, canvas, encode and upload go through an
 * injected `deps` object. These tests drive it with a recording fake and
 * assert the call SEQUENCE — clearRect then drawImage, once per slide — and
 * the surrounding decode/encode/upload contract, not pixels.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  stripWidth,
  paintSlide,
  renderSplit,
  renderAndUpload,
} from '../src/plugins/carousel/render.js';
import { sliceRects, canvasSize } from '../src/plugins/carousel/geometry.js';

/** A ctx that records every call as `[method, ...args]`. */
function recordingCtx(log) {
  return {
    clearRect: (...a) => log.push(['clearRect', ...a]),
    drawImage: (...a) => log.push(['drawImage', ...a]),
  };
}

/**
 * A deps fake: a fixed-size source bitmap, canvases that share the call log,
 * an encoder that returns a labelled blob, and an upload that echoes back a
 * media row.
 */
function fakeDeps({ srcW = 3000, srcH = 1000, encode = () => new Blob(['jpg']) } = {}) {
  const log = [];
  const closed = { count: 0 };
  const uploads = [];
  const deps = {
    fetchBlob: async (url) => {
      log.push(['fetchBlob', url]);
      return new Blob(['src']);
    },
    decode: async (blob, opts) => {
      log.push(['decode', opts.resizeWidth, opts.resizeQuality]);
      return { width: srcW, height: srcH, close: () => { closed.count++; } };
    },
    makeSurface: (w, h) => {
      log.push(['makeSurface', w, h]);
      return { canvas: { w, h }, ctx: recordingCtx(log) };
    },
    encode: async (canvas, type, quality) => {
      log.push(['encode', type, quality]);
      return encode();
    },
    upload: async (file, meta) => {
      uploads.push({ name: file.name, meta });
      return { id: uploads.length, path: `/2026/08/${file.name}` };
    },
  };
  return { deps, log, closed, uploads };
}

describe('stripWidth', () => {
  test('n · slideWidth, capped', () => {
    assert.strictEqual(stripWidth(3, '4:5'), 3240);
    assert.strictEqual(stripWidth(1, '1:1'), 1080);
    assert.strictEqual(stripWidth(10, '4:5'), 4096); // 10800 clamped to the cap
  });
});

describe('paintSlide', () => {
  test('clears then blits the source rect, in that order', () => {
    const log = [];
    const rect = { sx: 10, sy: 0, sw: 100, sh: 200, dx: 0, dy: 0, dw: 1080, dh: 1350 };
    paintSlide(recordingCtx(log), 'BMP', rect, 1080, 1350);
    assert.deepStrictEqual(log, [
      ['clearRect', 0, 0, 1080, 1350],
      ['drawImage', 'BMP', 10, 0, 100, 200, 0, 0, 1080, 1350],
    ]);
  });
});

describe('renderSplit', () => {
  test('decodes once (downscaled), paints clearRect→drawImage per slide, closes the bitmap', async () => {
    const { deps, log, closed } = fakeDeps({ srcW: 3000, srcH: 1000 });
    const blobs = await renderSplit('/2026/08/wide.jpg', 3, '4:5', deps);

    assert.strictEqual(blobs.length, 3);
    assert.strictEqual(closed.count, 1, 'bitmap closed exactly once');

    const [w, h] = canvasSize('4:5');
    const rects = sliceRects(3000, 1000, 3, '4:5');
    const expected = [
      ['fetchBlob', '/2026/08/wide.jpg'],
      ['decode', 3240, 'high'],
    ];
    for (let i = 0; i < 3; i++) {
      const r = rects[i];
      expected.push(['makeSurface', w, h]);
      expected.push(['clearRect', 0, 0, w, h]);
      expected.push(['drawImage', undefined, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh]);
      expected.push(['encode', 'image/jpeg', 0.92]);
    }
    // drawImage's bitmap arg is the object the fake decode returned; compare
    // the rest positionally by blanking it.
    const normalized = log.map((entry) =>
      entry[0] === 'drawImage' ? ['drawImage', undefined, ...entry.slice(2)] : entry,
    );
    assert.deepStrictEqual(normalized, expected);
  });

  test('a null from the encoder is a hard error, not a skipped slide', async () => {
    const { deps } = fakeDeps({ encode: () => null });
    await assert.rejects(
      () => renderSplit('/x.jpg', 2, '1:1', deps),
      /toBlob returned null/,
    );
  });

  test('closes the bitmap even when a slide fails', async () => {
    const { deps, closed } = fakeDeps({ encode: () => null });
    await renderSplit('/x.jpg', 2, '1:1', deps).catch(() => {});
    assert.strictEqual(closed.count, 1);
  });
});

describe('renderAndUpload', () => {
  test('uploads each slide with post_id set, in deck order', async () => {
    const { deps, uploads } = fakeDeps();
    const media = await renderAndUpload(
      { source: '/2026/08/wide.jpg', n: 3, aspect: '4:5', postId: 42 },
      deps,
    );

    assert.deepStrictEqual(
      uploads.map((u) => u.name),
      ['carousel-42-1.jpg', 'carousel-42-2.jpg', 'carousel-42-3.jpg'],
    );
    assert.ok(uploads.every((u) => u.meta.post_id === 42));
    assert.deepStrictEqual(
      media.map((m) => m.path),
      ['/2026/08/carousel-42-1.jpg', '/2026/08/carousel-42-2.jpg', '/2026/08/carousel-42-3.jpg'],
    );
  });
});
