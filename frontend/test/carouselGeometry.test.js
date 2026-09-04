/**
 * carousel/geometry.js — the pure math behind the slide builder.
 *
 * Every function is numbers in, plain objects out, so this file needs no DOM
 * and no canvas. The draw layer (a later bead) is a thin shim over these
 * results; if the geometry is right, the pixels are right.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  ASPECTS,
  canvasSize,
  sliceRects,
  fitReport,
  slideCountOptions,
  fitRect,
  safeAreaRect,
  clampPan,
  wrapText,
  autoFitText,
} from '../src/plugins/carousel/geometry.js';

/** measureText-shaped fake: every glyph is `fontSize/2` px wide. */
const measure = (text, fontSize) => ({ width: text.length * fontSize * 0.5 });

describe('canvasSize', () => {
  test('known aspects', () => {
    assert.deepStrictEqual(canvasSize('4:5'), [1080, 1350]);
    assert.deepStrictEqual(canvasSize('1:1'), [1080, 1080]);
    assert.deepStrictEqual(canvasSize('1.91:1'), [1080, 566]);
  });
  test('unknown aspect falls back to 4:5', () => {
    assert.deepStrictEqual(canvasSize('bogus'), [1080, 1350]);
  });
});

describe('sliceRects', () => {
  test('splits a wide source into n gap-free columns, each a full canvas', () => {
    for (const n of [2, 3, 4, 5, 7, 10]) {
      const rects = sliceRects(3000, 1000, n, '4:5');
      assert.strictEqual(rects.length, n);
      for (const r of rects) {
        assert.deepStrictEqual(
          [r.dx, r.dy, r.dw, r.dh],
          [0, 0, 1080, 1350],
          `n=${n}: destination is the whole canvas`,
        );
        assert.ok(r.sx >= 0 && r.sx + r.sw <= 3000 + 1e-9, `n=${n}: inside source width`);
        assert.ok(r.sy >= 0 && r.sy + r.sh <= 1000 + 1e-9, `n=${n}: inside source height`);
      }
      for (let i = 1; i < n; i++) {
        assert.strictEqual(
          rects[i].sx,
          rects[i - 1].sx + rects[i - 1].sw,
          `n=${n}: column ${i} starts where ${i - 1} ended`,
        );
      }
    }
  });

  test('the strip carries the combined deck aspect ratio', () => {
    const n = 3;
    const rects = sliceRects(3000, 1000, n, '4:5');
    const stripW = rects.reduce((sum, r) => sum + r.sw, 0);
    const stripH = rects[0].sh;
    assert.ok(Math.abs(stripW / stripH - (n * 1080) / 1350) < 1e-9);
  });

  test('non-integer division leaves no seam and no overflow', () => {
    // 999·1080/1350 = 799.2 px per column — non-integer. The columns must still
    // tile the strip with no seam and no overflow past the source.
    const rects = sliceRects(5000, 999, 3, '4:5');
    for (let i = 1; i < rects.length; i++) {
      assert.strictEqual(rects[i].sx, rects[i - 1].sx + rects[i - 1].sw, `seam at ${i}`);
    }
    const first = rects[0];
    const last = rects[rects.length - 1];
    assert.ok(first.sx >= 0 && last.sx + last.sw <= 5000 + 1e-9);
    // strip is centred: the gap before it equals the gap after it
    assert.ok(Math.abs(first.sx - (5000 - (last.sx + last.sw))) < 1e-9);
  });

  test('a source narrower than n·targetWidth still yields in-bounds rects', () => {
    const rects = sliceRects(500, 1000, 4, '4:5');
    assert.strictEqual(rects.length, 4);
    for (const r of rects) {
      assert.ok(r.sx >= 0 && r.sx + r.sw <= 500 + 1e-9);
      assert.ok(r.sy >= 0 && r.sy + r.sh <= 1000 + 1e-9);
      assert.ok(r.sw > 0 && r.sh > 0);
    }
  });

  test('n<1 is treated as a single slide', () => {
    assert.strictEqual(sliceRects(1000, 1000, 0, '1:1').length, 1);
  });

  test('every source rect field is a whole pixel', () => {
    for (const [w, h, n] of [[5000, 999, 3], [500, 1000, 4], [4096, 3771, 7]]) {
      for (const r of sliceRects(w, h, n, '4:5')) {
        for (const k of ['sx', 'sy', 'sw', 'sh', 'dx', 'dy', 'dw', 'dh']) {
          assert.ok(Number.isInteger(r[k]), `${w}x${h} n=${n}: ${k}=${r[k]} not integer`);
        }
      }
    }
  });

  test('the 5th arg is optional and anchorY 0.5 reproduces the centred crop', () => {
    const bare = sliceRects(3000, 2000, 3, '4:5');
    assert.deepStrictEqual(bare, sliceRects(3000, 2000, 3, '4:5', {}));
    assert.deepStrictEqual(bare, sliceRects(3000, 2000, 3, '4:5', { anchorY: 0.5 }));
    assert.deepStrictEqual(bare, sliceRects(3000, 2000, 3, '4:5', { strategy: 'cover' }));
  });

  test('anchorY slides the vertical band through the slack', () => {
    // 500x3000 into 1:1: a 500px-tall band with 2500px of vertical slack.
    const top = sliceRects(500, 3000, 1, '1:1', { anchorY: 0 })[0];
    const mid = sliceRects(500, 3000, 1, '1:1', { anchorY: 0.5 })[0];
    const bot = sliceRects(500, 3000, 1, '1:1', { anchorY: 1 })[0];
    assert.strictEqual(top.sy, 0);
    assert.strictEqual(mid.sy, 1250);
    assert.strictEqual(bot.sy, 2500);
    assert.ok(bot.sy + bot.sh <= 3000, 'the band never runs past the source');
    // anchorY is clamped to [0, 1]
    assert.deepStrictEqual(sliceRects(500, 3000, 1, '1:1', { anchorY: -5 })[0], top);
    assert.deepStrictEqual(sliceRects(500, 3000, 1, '1:1', { anchorY: 5 })[0], bot);
  });

  test("strategy 'exact' lays n 1:1 canvases side by side, centred", () => {
    const rects = sliceRects(4096, 2000, 3, '4:5', { strategy: 'exact' });
    assert.strictEqual(rects.length, 3);
    assert.deepStrictEqual(rects.map((r) => r.sx), [428, 1508, 2588]); // (4096-3240)/2 = 428
    for (const r of rects) {
      assert.strictEqual(r.sw, 1080);
      assert.strictEqual(r.sh, 1350);
      assert.deepStrictEqual([r.dx, r.dy, r.dw, r.dh], [0, 0, 1080, 1350]);
      assert.ok(!('pad' in r));
    }
  });

  test("strategy 'pad' runs flush left; the last slide carries the tail + a pad region", () => {
    const rects = sliceRects(4096, 2000, 4, '4:5', { strategy: 'pad' });
    assert.strictEqual(rects.length, 4);
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(rects[i].sx, i * 1080);
      assert.strictEqual(rects[i].sw, 1080);
      assert.strictEqual(rects[i].dw, 1080);
      assert.ok(!('pad' in rects[i]));
    }
    const tail = rects[3];
    assert.strictEqual(tail.sx, 3240);
    assert.strictEqual(tail.sw, 856); // 4096 - 3*1080
    assert.strictEqual(tail.dw, 856); // drawn 1:1, flush left
    assert.deepStrictEqual(tail.pad, { x: 856, w: 224 }); // 224 = 4*1080 - 4096
  });

  test("'exact'/'pad' fall back to cover when the source is too short or too narrow", () => {
    // too short for a 1:1 band at scale 1
    assert.deepStrictEqual(
      sliceRects(3000, 1000, 3, '4:5', { strategy: 'exact' }),
      sliceRects(3000, 1000, 3, '4:5'),
    );
    // too narrow for 3 full columns
    assert.deepStrictEqual(
      sliceRects(2000, 2000, 3, '4:5', { strategy: 'exact' }),
      sliceRects(2000, 2000, 3, '4:5'),
    );
  });
});

describe('fitReport', () => {
  test('cover reports an upscale when the source is smaller than the deck', () => {
    const r = fitReport(4000, 5000, 4, '4:5');
    assert.strictEqual(r.n, 4);
    assert.strictEqual(r.feasible, true);
    assert.ok(Math.abs(r.scale - 1.08) < 1e-9); // 4*1080 / 4000
    assert.strictEqual(r.quality, 'upscale');
    assert.strictEqual(r.padPx, 0);
    assert.ok(Math.abs(r.stripW - 4000) < 1e-9);
    assert.ok(Math.abs(r.trimmedH - 3750) < 1e-9); // 5000 - 1350/1.08
  });

  test('cover reports a downscale when the source dwarfs the deck', () => {
    const r = fitReport(8000, 2000, 3, '4:5');
    assert.ok(Math.abs(r.scale - 0.675) < 1e-9); // 1350 / 2000
    assert.strictEqual(r.quality, 'downscale');
    assert.ok(Math.abs(r.trimmedW - 3200) < 1e-9); // 8000 - 3240/0.675
  });

  test('exact takes floor(srcW/dstW) slides at scale 1 and trims the width remainder', () => {
    const r = fitReport(4096, 2000, 0, '4:5', 'exact');
    assert.deepStrictEqual(
      [r.n, r.scale, r.feasible, r.quality, r.padPx],
      [3, 1, true, 'exact', 0],
    );
    assert.strictEqual(r.trimmedW, 856); // 4096 - 3*1080
    assert.strictEqual(r.trimmedH, 650); // 2000 - 1350
  });

  test('pad takes ceil(srcW/dstW) slides at scale 1 and reports the tail fill', () => {
    const r = fitReport(4096, 2000, 0, '4:5', 'pad');
    assert.deepStrictEqual([r.n, r.scale, r.feasible], [4, 1, true]);
    assert.strictEqual(r.padPx, 224); // 4*1080 - 4096
    assert.strictEqual(r.trimmedW, 0);
  });

  test('an exact multiple pads to zero', () => {
    assert.strictEqual(fitReport(3240, 2000, 0, '4:5', 'pad').padPx, 0);
  });

  test('exact/pad are infeasible when the source is shorter than one canvas', () => {
    assert.strictEqual(fitReport(4096, 1000, 0, '4:5', 'exact').feasible, false);
    assert.strictEqual(fitReport(4096, 1000, 0, '4:5', 'pad').feasible, false);
  });

  test('exact is infeasible when the source is narrower than one canvas', () => {
    assert.strictEqual(fitReport(900, 3000, 0, '4:5', 'exact').feasible, false);
  });
});

describe('slideCountOptions', () => {
  test('one feasible entry per stored strategy, scale-1 strategies ranked first', () => {
    const opts = slideCountOptions(4096, 2000, '4:5', { min: 2, max: 20 });
    assert.strictEqual(opts.length, 3);
    assert.deepStrictEqual(
      opts
        .map((o) => o.strategy)
        .slice(0, 2)
        .sort(),
      ['exact', 'pad'],
    );
    assert.strictEqual(opts.at(-1).strategy, 'cover');

    const exact = opts.find((o) => o.strategy === 'exact');
    assert.deepStrictEqual(
      [exact.n, exact.scale, exact.padPx, exact.label],
      [3, 1, 0, '3 slides · pixel-exact'],
    );
    const pad = opts.find((o) => o.strategy === 'pad');
    assert.deepStrictEqual([pad.n, pad.padPx, pad.label], [4, 224, '4 slides · 224px padding']);
    const cover = opts.find((o) => o.strategy === 'cover');
    assert.deepStrictEqual([cover.n, cover.label], [4, '4 slides · 5% upscale']);
  });

  test('infeasible exact/pad are omitted, leaving only cover', () => {
    const opts = slideCountOptions(4096, 1000, '4:5', {});
    assert.deepStrictEqual(
      opts.map((o) => o.strategy),
      ['cover'],
    );
  });

  test('exact/pad outside the count bounds are omitted; cover is clamped in', () => {
    const opts = slideCountOptions(4096, 2000, '4:5', { min: 6, max: 20 });
    assert.strictEqual(opts.length, 1);
    assert.deepStrictEqual([opts[0].strategy, opts[0].n], ['cover', 6]);
  });
});

describe('fitRect', () => {
  test('cover crops the overflowing axis, fills the frame', () => {
    const r = fitRect(2000, 1000, 1080, 1350, 'cover');
    assert.deepStrictEqual([r.dx, r.dy, r.dw, r.dh], [0, 0, 1080, 1350]);
    assert.strictEqual(r.sh, 1000);
    assert.strictEqual(r.sw, 800); // srcH * (1080/1350)
    assert.strictEqual(r.sx, 600); // centred
    assert.strictEqual(r.sy, 0);
  });

  test('cover on a tall source crops top and bottom', () => {
    const r = fitRect(500, 1000, 1080, 1080, 'cover');
    assert.strictEqual(r.sw, 500);
    assert.strictEqual(r.sh, 500);
    assert.strictEqual(r.sy, 250);
    assert.strictEqual(r.sx, 0);
  });

  test('contain shows the whole source, letterboxed and centred', () => {
    const r = fitRect(2000, 1000, 1080, 1350, 'contain');
    assert.deepStrictEqual([r.sx, r.sy, r.sw, r.sh], [0, 0, 2000, 1000]);
    assert.strictEqual(r.dw, 1080);
    assert.strictEqual(r.dh, 540); // dstW / srcAspect
    assert.strictEqual(r.dx, 0);
    assert.strictEqual(r.dy, 405); // (1350 - 540) / 2
  });

  test('contain on a tall source pillarboxes', () => {
    const r = fitRect(500, 1000, 1080, 1080, 'contain');
    assert.strictEqual(r.dh, 1080);
    assert.strictEqual(r.dw, 540); // dstH * srcAspect
    assert.strictEqual(r.dx, 270);
    assert.strictEqual(r.dy, 0);
  });
});

describe('safeAreaRect', () => {
  for (const aspect of Object.keys(ASPECTS)) {
    test(`${aspect}: a positive rect inside the canvas`, () => {
      const [w, h] = canvasSize(aspect);
      const s = safeAreaRect(aspect);
      assert.ok(s.w > 0 && s.h > 0);
      assert.ok(s.x > 0 && s.y > 0);
      assert.ok(s.x + s.w <= w + 1e-9);
      assert.ok(s.y + s.h <= h + 1e-9);
      assert.ok(s.w < w && s.h < h, 'narrower and shorter than the full canvas');
    });
  }

  test('4:5 reserves at least the feed grid-crop band', () => {
    const s = safeAreaRect('4:5');
    assert.ok(s.y >= (1350 - 1080) / 2);
  });
});

describe('clampPan', () => {
  test('keeps a panned crop inside the source at every edge', () => {
    const base = { w: 0.4, h: 0.4 };
    assert.strictEqual(clampPan({ ...base, x: -0.5, y: 0 }, 3000, 2000).x, 0);
    assert.strictEqual(clampPan({ ...base, x: 0, y: -0.5 }, 3000, 2000).y, 0);
    assert.ok(Math.abs(clampPan({ ...base, x: 0.9, y: 0 }, 3000, 2000).x - 0.6) < 1e-9);
    assert.ok(Math.abs(clampPan({ ...base, x: 0, y: 0.9 }, 3000, 2000).y - 0.6) < 1e-9);
  });

  test('zoom-out past the whole image is pinned to the whole image', () => {
    const c = clampPan({ x: 0.3, y: 0.3, w: 1.5, h: 2 }, 3000, 2000);
    assert.deepStrictEqual(c, { x: 0, y: 0, w: 1, h: 1 });
  });

  test('a crop smaller than one source pixel is widened to one pixel', () => {
    const c = clampPan({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 1000, 1000);
    assert.strictEqual(c.w, 0.001);
    assert.strictEqual(c.h, 0.001);
  });
});

describe('wrapText', () => {
  test('greedy packs words within maxWidth', () => {
    // glyph = 5px at size 10; "the quick" = 45 <= 50, "the quick brown" = 75 > 50.
    assert.deepStrictEqual(
      wrapText('the quick brown fox', 50, 10, measure),
      ['the quick', 'brown fox'],
    );
  });

  test('blank input is an empty array', () => {
    assert.deepStrictEqual(wrapText('', 100, 10, measure), []);
    assert.deepStrictEqual(wrapText('   ', 100, 10, measure), []);
  });

  test('a word wider than maxWidth gets its own line, uncut', () => {
    assert.deepStrictEqual(
      wrapText('supercalifragilistic', 50, 10, measure),
      ['supercalifragilistic'],
    );
  });
});

describe('autoFitText', () => {
  test('picks the largest integer size whose wrapped lines fit the box', () => {
    const { fontSize, lines } = autoFitText({
      text: 'hello world',
      maxWidth: 100,
      maxHeight: 400,
      measure,
    });
    // widest word is 5 glyphs; 5 * size * 0.5 <= 100  ->  size <= 40.
    assert.strictEqual(fontSize, 40);
    assert.deepStrictEqual(lines, ['hello', 'world']);
    for (const line of lines) assert.ok(measure(line, fontSize).width <= 100);
  });

  test('a short box forces a smaller size', () => {
    const roomy = autoFitText({ text: 'hello world', maxWidth: 100, maxHeight: 400, measure });
    const cramped = autoFitText({ text: 'hello world', maxWidth: 100, maxHeight: 60, measure });
    assert.ok(cramped.fontSize < roomy.fontSize);
    assert.ok(cramped.lines.length * cramped.fontSize * 1.2 <= 60);
  });

  test('falls back to min when nothing fits', () => {
    const { fontSize } = autoFitText({
      text: 'hello',
      maxWidth: 10,
      maxHeight: 5,
      measure,
      min: 8,
    });
    assert.strictEqual(fontSize, 8);
  });

  test('wraps to more lines as the box narrows', () => {
    const wide = autoFitText({ text: 'one two three four', maxWidth: 400, maxHeight: 400, measure });
    const narrow = autoFitText({ text: 'one two three four', maxWidth: 60, maxHeight: 400, measure });
    assert.ok(narrow.lines.length > wide.lines.length);
    assert.ok(narrow.fontSize <= wide.fontSize);
  });
});
