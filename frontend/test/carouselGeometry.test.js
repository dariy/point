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
  backgroundFit,
  deckSlideRects,
  deckSlideFitCSS,
  padRects,
  gradientLine,
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

describe('backgroundFit', () => {
  test('cover, no crop: n frames tile evenly with no seam', () => {
    // 2000×1000 into two 1080×1080 slides: the deck aspect (2160/1080) equals
    // the source aspect (2000/1000) exactly, so nothing is trimmed in either
    // direction — every excess is ~0 and every position guards to 0.
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ~ ${b}`);
    const frame0 = backgroundFit(2000, 1000, '1:1', 2, 'cover', 0.5, 1, 0);
    const frame1 = backgroundFit(2000, 1000, '1:1', 2, 'cover', 0.5, 1, 1);
    const stage = backgroundFit(2000, 1000, '1:1', 2, 'cover', 0.5, 2, 0);

    near(frame0.size[0], 200);
    near(frame0.size[1], 100);
    near(frame0.position[0], 0);
    near(frame1.size[0], 200);
    near(frame1.position[0], 100);
    near(stage.size[0], 100);
    near(stage.size[1], 100);
  });

  test('cover with a real horizontal trim centres on the stage and every frame', () => {
    // Same source/count as the fitReport downscale case: trimmedW = 3200.
    const stage = backgroundFit(8000, 2000, '4:5', 3, 'cover', 0.5, 3, 0);
    assert.strictEqual(stage.position[0], 50);
    // size matches scale·srcW / (n·dstW) — scale is 0.675 here.
    assert.ok(Math.abs(stage.size[0] - (8000 * 0.675) / (3 * 1080) * 100) < 1e-9);
  });

  test('exact centres its trim — the stage sits at 50%, frames step symmetrically', () => {
    // 4096×2000 exact: n=3, trimmedW=856 (matches the fitReport case above).
    const stage = backgroundFit(4096, 2000, '4:5', 3, 'exact', 0.5, 3, 0);
    assert.strictEqual(stage.position[0], 50);

    const first = backgroundFit(4096, 2000, '4:5', 3, 'exact', 0.5, 1, 0);
    const last = backgroundFit(4096, 2000, '4:5', 3, 'exact', 0.5, 1, 2);
    // Pixel-exact: every frame shows the same 4096×2000 image at scale 1, so
    // its size relative to a 1080×1350 frame box is strategy-independent —
    // only the position (which window of it shows) differs.
    assert.deepStrictEqual(first.size, last.size);
    assert.ok(Math.abs(first.size[0] - (4096 / 1080) * 100) < 1e-9);
    // The crop is centred, so the first and last frame's offsets from their
    // respective edges are mirror images of each other.
    assert.ok(Math.abs(first.position[0] + last.position[0] - 100) < 1e-9);
  });

  test('pad sits flush-left — the stage and the padded last frame both start at 0%', () => {
    // 4096×2000 pad: n=4, padPx=224 (matches the fitReport case above).
    const stage = backgroundFit(4096, 2000, '4:5', 4, 'pad', 0.5, 4, 0);
    assert.strictEqual(stage.position[0], 0);
    assert.ok(!Object.is(stage.position[0], -0), 'normalized away from -0');

    const last = backgroundFit(4096, 2000, '4:5', 4, 'pad', 0.5, 1, 3);
    // The image only reaches 4096-3·1080=856px into the last 1080px frame —
    // recovering that gap from size/position pins the pad hatch's width.
    const boxW = 1080;
    const bgWpx = (last.size[0] / 100) * boxW;
    const offsetXpx = (boxW - bgWpx) * (last.position[0] / 100);
    const imageRightEdgePx = offsetXpx + bgWpx; // where the source's last pixel lands
    assert.ok(Math.abs((boxW - imageRightEdgePx) - 224) < 1e-6);
  });

  test('anchorY drives the vertical position on the stage and every frame alike', () => {
    for (const anchorY of [0, 0.25, 1]) {
      const stage = backgroundFit(4000, 5000, '4:5', 4, 'cover', anchorY, 4, 0);
      const frame = backgroundFit(4000, 5000, '4:5', 4, 'cover', anchorY, 1, 2);
      assert.ok(Math.abs(stage.position[1] - anchorY * 100) < 1e-9);
      assert.ok(Math.abs(frame.position[1] - anchorY * 100) < 1e-9);
    }
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

describe('deckSlideRects', () => {
  test('cover fills the frame, centre-cropping the crop to the slide aspect', () => {
    // Crop is the whole 2000×1000 source; 4:5 wants 1080:1350, so the source is
    // far too wide — full height, a centred 800px-wide column.
    const r = deckSlideRects(2000, 1000, '4:5', { x: 0, y: 0, w: 1, h: 1 }, 'cover');
    assert.deepStrictEqual([r.dx, r.dy, r.dw, r.dh], [0, 0, 1080, 1350]);
    assert.deepStrictEqual([r.sx, r.sy, r.sw, r.sh], [600, 0, 800, 1000]);
    assert.strictEqual(r.pad, undefined, 'cover never pads');
  });

  test('cover honours pan and zoom — the crop selects, the frame aspect trims', () => {
    // A half-width, half-height window at (0.25, 0.25) of a 4000×4000 source:
    // 1000×1000 px, which a 1:1 slide takes whole.
    const r = deckSlideRects(4000, 4000, '1:1', { x: 0.25, y: 0.25, w: 0.25, h: 0.25 }, 'cover');
    assert.deepStrictEqual([r.sx, r.sy, r.sw, r.sh], [1000, 1000, 1000, 1000]);
    assert.deepStrictEqual([r.dx, r.dy, r.dw, r.dh], [0, 0, 1080, 1080]);
  });

  test('contain shows the whole crop, letterboxed, and reports both pad bars', () => {
    // A 2000×1000 crop is wider than a 1:1 frame, so it keeps the full width
    // and gives up height — a bar above and a bar below.
    const r = deckSlideRects(2000, 1000, '1:1', { x: 0, y: 0, w: 1, h: 1 }, 'contain');
    assert.deepStrictEqual([r.sx, r.sy, r.sw, r.sh], [0, 0, 2000, 1000]);
    assert.strictEqual(r.dw, 1080);
    assert.strictEqual(r.dh, 540);
    assert.strictEqual(r.dx, 0);
    assert.strictEqual(r.dy, 270);
    assert.strictEqual(r.pad.length, 2, 'a bar above and a bar below');
    for (const p of r.pad) assert.strictEqual(p.w, 1080);
    assert.deepStrictEqual(
      r.pad.map((p) => [p.y, p.h]),
      [
        [0, 270],
        [810, 270],
      ],
    );
  });

  test('contain pillarboxes a tall crop, and the pad rects tile the uncovered area', () => {
    const r = deckSlideRects(1000, 2000, '1:1', { x: 0, y: 0, w: 1, h: 1 }, 'contain');
    assert.deepStrictEqual([r.dx, r.dy, r.dw, r.dh], [270, 0, 540, 1080]);
    const padArea = r.pad.reduce((sum, p) => sum + p.w * p.h, 0);
    assert.strictEqual(padArea, 1080 * 1080 - 540 * 1080, 'pad + content = the frame');
    // Disjoint: no two pad rects overlap, so a fill cannot double-paint.
    for (let i = 0; i < r.pad.length; i++) {
      for (let j = i + 1; j < r.pad.length; j++) {
        const a = r.pad[i];
        const b = r.pad[j];
        const overlaps =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!overlaps, `pad ${i} and ${j} overlap`);
      }
    }
  });

  test('contain omits pad when the crop already matches the slide aspect', () => {
    const r = deckSlideRects(2000, 2500, '4:5', { x: 0, y: 0, w: 1, h: 1 }, 'contain');
    assert.deepStrictEqual([r.dx, r.dy, r.dw, r.dh], [0, 0, 1080, 1350]);
    assert.strictEqual(r.pad, undefined);
  });

  test('source rects are whole pixels and stay inside the source', () => {
    const sources = [
      [1999, 1333],
      [777, 1001],
      [4001, 3],
    ];
    for (const [w, h] of sources) {
      for (const fit of ['cover', 'contain']) {
        const r = deckSlideRects(w, h, '4:5', { x: 0.137, y: 0.291, w: 0.613, h: 0.409 }, fit);
        for (const k of ['sx', 'sy', 'sw', 'sh', 'dx', 'dy', 'dw', 'dh']) {
          assert.ok(Number.isInteger(r[k]), `${w}×${h} ${fit}: ${k}=${r[k]} is a whole pixel`);
        }
        assert.ok(r.sw >= 1 && r.sh >= 1, `${w}×${h} ${fit}: non-empty source rect`);
        assert.ok(r.sx >= 0 && r.sx + r.sw <= w, `${w}×${h} ${fit}: inside source width`);
        assert.ok(r.sy >= 0 && r.sy + r.sh <= h, `${w}×${h} ${fit}: inside source height`);
      }
    }
  });

  test('degenerate inputs clamp instead of throwing', () => {
    const finite = (r) => Object.values(r).every((v) => (Array.isArray(v) ? true : Number.isFinite(v)));

    // No source yet: nothing to draw, the whole frame is background.
    const none = deckSlideRects(0, 0, '4:5', { x: 0, y: 0, w: 1, h: 1 }, 'cover');
    assert.deepStrictEqual([none.sw, none.sh, none.dw, none.dh], [0, 0, 0, 0]);
    assert.deepStrictEqual(none.pad, [{ x: 0, y: 0, w: 1080, h: 1350 }]);

    // A zero-area crop is pinned to one source pixel by clampPan.
    const zero = deckSlideRects(2000, 1000, '4:5', { x: 0.5, y: 0.5, w: 0, h: 0 }, 'cover');
    assert.ok(finite(zero) && zero.sw >= 1 && zero.sh >= 1);

    // Garbage in — an unknown fit falls back to cover, NaN to the full frame.
    const junk = deckSlideRects(2000, 1000, '4:5', { x: NaN, y: undefined, w: 'x', h: null }, 'wat');
    assert.deepStrictEqual(junk, deckSlideRects(2000, 1000, '4:5', { x: 0, y: 0, w: 1, h: 1 }, 'cover'));
    assert.ok(finite(deckSlideRects(-5, -5, '1:1', undefined, 'contain')));
  });
});

describe('padRects', () => {
  test("the split path's {x, w} tail gap becomes one full-height rect", () => {
    const [rect] = sliceRects(3000, 1350, 3, '4:5', { strategy: 'pad' }).slice(-1);
    assert.ok(rect.pad, 'the tail slide is short');
    assert.deepStrictEqual(padRects(rect, 1080, 1350), [
      { x: rect.pad.x, y: 0, w: rect.pad.w, h: 1350 },
    ]);
  });

  test("the deck path's rect array passes through, so both fill the same way", () => {
    const rect = deckSlideRects(2000, 1000, '1:1', { x: 0, y: 0, w: 1, h: 1 }, 'contain');
    assert.deepStrictEqual(padRects(rect, 1080, 1080), rect.pad);
  });

  test('a fully covered frame reports no rects at all', () => {
    const cover = deckSlideRects(2000, 1000, '4:5', { x: 0, y: 0, w: 1, h: 1 }, 'cover');
    assert.deepStrictEqual(padRects(cover, 1080, 1350), []);
    assert.deepStrictEqual(padRects({}, 1080, 1350), []);
    assert.deepStrictEqual(padRects(null, 1080, 1350), []);
  });

  test('zero-area and garbage entries are dropped, not painted', () => {
    const rect = {
      pad: [
        { x: 0, y: 0, w: 0, h: 1350 },
        { x: 0, y: 0, w: 100, h: 0 },
        null,
        { x: 10, y: 20, w: 30, h: 40 },
      ],
    };
    assert.deepStrictEqual(padRects(rect, 1080, 1350), [{ x: 10, y: 20, w: 30, h: 40 }]);
  });
});

describe('gradientLine', () => {
  test('follows the CSS linear-gradient() angle convention', () => {
    // 0deg points to the top, so the line RUNS from the bottom edge upward.
    assert.deepStrictEqual(gradientLine(0, 1080, 1350), { x0: 540, y0: 1350, x1: 540, y1: 0 });
    assert.deepStrictEqual(gradientLine(90, 1080, 1350), { x0: 0, y0: 675, x1: 1080, y1: 675 });
    assert.deepStrictEqual(gradientLine(180, 1080, 1350), { x0: 540, y0: 0, x1: 540, y1: 1350 });
    assert.deepStrictEqual(gradientLine(270, 1080, 1350), { x0: 1080, y0: 675, x1: 0, y1: 675 });
  });

  test('the line is long enough to reach the corner-most stop', () => {
    // At 45° across a square, |w·sin| + |h·cos| is the diagonal.
    const l = gradientLine(45, 1000, 1000);
    const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0);
    assert.ok(Math.abs(len - Math.SQRT2 * 1000) < 1, `length ${len}`);
    // Centred on the frame either way.
    assert.strictEqual((l.x0 + l.x1) / 2, 500);
    assert.strictEqual((l.y0 + l.y1) / 2, 500);
  });

  test('angles wrap, and an unusable one falls back to top → bottom', () => {
    const down = gradientLine(180, 1080, 1350);
    assert.deepStrictEqual(gradientLine(540, 1080, 1350), down);
    assert.deepStrictEqual(gradientLine(-180, 1080, 1350), down);
    assert.deepStrictEqual(gradientLine(NaN, 1080, 1350), down);
    assert.deepStrictEqual(gradientLine(undefined, 1080, 1350), down);
  });

  test('endpoints are whole pixels, so the call sequence is assertable', () => {
    for (const deg of [0, 17, 45, 123, 200, 359]) {
      const l = gradientLine(deg, 1080, 1350);
      for (const k of ['x0', 'y0', 'x1', 'y1']) {
        assert.ok(Number.isInteger(l[k]), `${deg}deg: ${k}=${l[k]}`);
      }
    }
  });
});

describe('deckSlideFitCSS', () => {
  test('agrees with deckSlideRects on the source region, for every fit and crop', () => {
    // The assertion that actually protects the feature: the DOM preview and the
    // canvas render must show the same pixels. Resolve the CSS percentages
    // against a nominal box of the slide's own canvas size, then check where the
    // source's crop edges land against the rects' destination.
    const sources = [
      [2000, 1000],
      [1000, 2000],
      [4096, 3072],
      [1999, 1333],
      [900, 900],
    ];
    const crops = [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      { x: 0, y: 0.4, w: 0.33, h: 0.6 },
      { x: 0.6, y: 0, w: 0.4, h: 0.2 },
      { x: 0.137, y: 0.291, w: 0.613, h: 0.409 },
    ];

    for (const [srcW, srcH] of sources) {
      for (const aspect of Object.keys(ASPECTS)) {
        for (const crop of crops) {
          for (const fit of ['cover', 'contain']) {
            const label = `${srcW}×${srcH} ${aspect} ${fit} ${JSON.stringify(crop)}`;
            const r = deckSlideRects(srcW, srcH, aspect, crop, fit);
            const css = deckSlideFitCSS(srcW, srcH, aspect, crop, fit);
            const [frameW, frameH] = canvasSize(aspect);
            // The image element, per `box`, in frame pixels.
            const elX = (css.box.x / 100) * frameW;
            const elY = (css.box.y / 100) * frameH;
            const elW = (css.box.w / 100) * frameW;
            const elH = (css.box.h / 100) * frameH;

            // Exactly what a browser does with background-size/position %.
            const bgW = (css.size[0] / 100) * elW;
            const bgH = (css.size[1] / 100) * elH;
            const bgX = elX + (css.position[0] / 100) * (elW - bgW);
            const bgY = elY + (css.position[1] / 100) * (elH - bgH);
            // Where source pixel u/v lands in the frame.
            const atX = (u) => bgX + (u / srcW) * bgW;
            const atY = (v) => bgY + (v / srcH) * bgH;

            const near = (a, b, what) =>
              assert.ok(Math.abs(a - b) < 1, `${label}: ${what} — ${a} vs ${b}`);
            // The element clips to the destination rect...
            near(elX, r.dx, 'element x');
            near(elY, r.dy, 'element y');
            near(elW, r.dw, 'element width');
            near(elH, r.dh, 'element height');
            // ...and the crop lands exactly on it.
            near(atX(r.sx), r.dx, 'crop left edge');
            near(atX(r.sx + r.sw), r.dx + r.dw, 'crop right edge');
            near(atY(r.sy), r.dy, 'crop top edge');
            near(atY(r.sy + r.sh), r.dy + r.dh, 'crop bottom edge');
          }
        }
      }
    }
  });

  test('cover with no crop matches backgroundFit for the single-slide case', () => {
    // A one-slide `cover` split IS a full-frame `cover` deck slide: same source,
    // same frame, no trim to anchor. The two families must not disagree.
    const deck = deckSlideFitCSS(2000, 1000, '1:1', { x: 0, y: 0, w: 1, h: 1 }, 'cover');
    const split = backgroundFit(2000, 1000, '1:1', 1, 'cover', 0.5, 1, 0);
    assert.ok(Math.abs(deck.size[0] - split.size[0]) < 0.01, `${deck.size[0]} ~ ${split.size[0]}`);
    assert.ok(Math.abs(deck.size[1] - split.size[1]) < 0.01, `${deck.size[1]} ~ ${split.size[1]}`);
    assert.ok(Math.abs(deck.position[0] - split.position[0]) < 0.01);
    assert.ok(Math.abs(deck.position[1] - split.position[1]) < 0.01);
    assert.deepStrictEqual(deck.box, { x: 0, y: 0, w: 100, h: 100 }, 'cover needs no inner box');
  });

  test('contain letterboxes the element, and the image fills that element', () => {
    // 2000×1000 into 1:1: the element is the middle half of the frame, and the
    // whole source fills it — the pad is the frame showing through above and
    // below, not part of the image element.
    const css = deckSlideFitCSS(2000, 1000, '1:1', { x: 0, y: 0, w: 1, h: 1 }, 'contain');
    assert.deepStrictEqual(css.box, { x: 0, y: 25, w: 100, h: 50 });
    assert.deepStrictEqual(css.size, [100, 100]);
    assert.deepStrictEqual(css.position, [0, 0]);
    assert.ok(!Object.is(css.position[0], -0), 'normalized away from -0');
  });

  test('contain clips a zoomed crop to the element, so the rest cannot bleed', () => {
    // The failure this contract exists for: a crop whose scaled full source is
    // exactly the frame height. Percent positions cannot offset an image that
    // matches its box, so a full-frame element would show the wrong band.
    const crop = { x: 0.6, y: 0, w: 0.4, h: 0.2 };
    const css = deckSlideFitCSS(2000, 1000, '4:5', crop, 'contain');
    const r = deckSlideRects(2000, 1000, '4:5', crop, 'contain');
    assert.deepStrictEqual(
      [css.box.x, css.box.y, css.box.w, css.box.h].map((v) => Math.round(v)),
      [0, Math.round((r.dy / 1350) * 100), 100, Math.round((r.dh / 1350) * 100)],
    );
    // Inside that element the image is oversized on both axes and pinned to the
    // crop's own corner — 100% x because the crop runs to the source's right edge.
    assert.ok(css.size[0] > 100 && css.size[1] > 100);
    assert.strictEqual(css.position[0], 100);
    assert.strictEqual(css.position[1], 0);
  });

  test('degenerate inputs give a neutral pair, never NaN', () => {
    for (const args of [
      [0, 0, '4:5', { x: 0, y: 0, w: 1, h: 1 }, 'cover'],
      [NaN, 100, '1:1', undefined, 'contain'],
      [1000, 0, '1.91:1', { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 'cover'],
    ]) {
      const css = deckSlideFitCSS(...args);
      assert.deepStrictEqual(css, {
        size: [100, 100],
        position: [50, 50],
        box: { x: 0, y: 0, w: 100, h: 100 },
      });
    }
    const zeroCrop = deckSlideFitCSS(2000, 1000, '4:5', { x: 0.5, y: 0.5, w: 0, h: 0 }, 'cover');
    assert.ok(
      [...zeroCrop.size, ...zeroCrop.position].every(Number.isFinite),
      'a zero-area crop still resolves',
    );
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
