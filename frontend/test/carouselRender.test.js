/**
 * carousel/render.js — the draw layer.
 *
 * render.js issues no measurements of its own (all from geometry.js) and
 * touches nothing real: decode, canvas, encode and upload go through an
 * injected `deps` object. These tests drive it with a recording fake and
 * assert the call SEQUENCE — clearRect then (pad fill then) drawImage, one
 * crop-and-resize decode per slide — and the surrounding
 * decode/probe/encode/upload contract, not pixels.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  paintSlide,
  renderSplit,
  renderDeck,
  renderCarousel,
  renderAndUpload,
} from '../src/plugins/carousel/render.js';
import {
  sliceRects,
  deckSlideRects,
  canvasSize,
  layerRect,
} from '../src/plugins/carousel/geometry.js';
import {
  normalizeDocument,
  normalizeLayer,
  splitDocument,
  toDeckDocument,
} from '../src/plugins/carousel/document.js';

/** Gradient handles the fake ctx has handed out, so a `fillStyle` carrying one
 *  logs as the plain string `'gradient'` instead of an unassertable object. */
const GRADIENTS = new WeakSet();

/** A stand-in for a real face: every glyph is half an em wide, so a measured
 *  width is `length x 0.5 x fontSize` — enough for wrap and auto-fit to have
 *  something monotone to decide against, and deterministic across machines. */
const CHAR_EM = 0.5;

/** The px size out of a CSS font shorthand (`600 42px "Inter", sans-serif`). */
function fontPx(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  return m ? Number(m[1]) : 0;
}

/** Every `fillText` in a log, with the font that was in effect for it. */
function painted(log) {
  return log
    .filter((e) => e[0] === 'fillText')
    .map(([, text, x, y, font]) => ({ text, x, y, size: fontPx(font), font }));
}

/** The log split per slide canvas — one segment per `makeSurface`. */
function surfaces(log) {
  const out = [];
  for (const entry of log) {
    if (entry[0] === 'makeSurface') out.push([]);
    else if (out.length) out[out.length - 1].push(entry);
  }
  return out;
}

/** A ctx that records every call and style assignment as `[name, ...args]`.
 *
 *  `font` is the exception: `measureText` sets it once per candidate size, so
 *  logging the assignments would bury the paint in the auto-fit scan. It is
 *  stored and reported as the last element of each `fillText` entry instead —
 *  which is the only place its value is a claim about the render. */
function recordingCtx(log) {
  const ctx = {
    font: '',
    clearRect: (...a) => log.push(['clearRect', ...a]),
    drawImage: (...a) => log.push(['drawImage', ...a]),
    fillRect: (...a) => log.push(['fillRect', ...a]),
    fillText: (text, x, y) => log.push(['fillText', text, x, y, ctx.font]),
    measureText: (text) => ({ width: text.length * CHAR_EM * fontPx(ctx.font) }),
    save: () => log.push(['save']),
    restore: () => log.push(['restore']),
    createLinearGradient: (...line) => {
      log.push(['createLinearGradient', ...line]);
      const grad = { addColorStop: (at, color) => log.push(['addColorStop', at, color]) };
      GRADIENTS.add(grad);
      return grad;
    },
  };
  for (const prop of [
    'fillStyle',
    'filter',
    'textAlign',
    'textBaseline',
    'shadowColor',
    'shadowBlur',
    'shadowOffsetY',
  ]) {
    let v;
    Object.defineProperty(ctx, prop, {
      get: () => v,
      set: (next) => {
        v = next;
        log.push([prop, GRADIENTS.has(next) ? 'gradient' : next]);
      },
    });
  }
  return ctx;
}

/**
 * A deps fake: a fixed natural source size, a decode that records its crop +
 * resize opts and hands back a bitmap sized to the resize, canvases that share
 * the call log, an encoder that returns a labelled blob, and an upload that
 * echoes back a media row.
 */
function fakeDeps({
  srcW = 3000,
  srcH = 1000,
  encode = () => new Blob(['jpg']),
  upload,
  // `null` omits the dep entirely — a deps object built before layers existed.
  resolveFont = async () => 'TestFace, sans-serif',
} = {}) {
  const log = [];
  const decodeCalls = [];
  const closed = { count: 0 };
  const uploads = [];
  const deletes = [];
  const progress = [];
  const fontCalls = { count: 0 };
  const deps = {
    fetchBlob: async (url) => {
      log.push(['fetchBlob', url]);
      return new Blob(['src']);
    },
    probeSize: async (url) => {
      log.push(['probeSize', url]);
      return { w: srcW, h: srcH };
    },
    decode: async (blob, opts) => {
      decodeCalls.push(opts);
      log.push(['decode', opts.sx, opts.sy, opts.sw, opts.sh, opts.resizeWidth, opts.resizeHeight]);
      return {
        width: opts.resizeWidth,
        height: opts.resizeHeight,
        close: () => { closed.count++; },
      };
    },
    makeSurface: (w, h) => {
      log.push(['makeSurface', w, h]);
      return { canvas: { w, h }, ctx: recordingCtx(log) };
    },
    encode: async (canvas, type, quality) => {
      log.push(['encode', type, quality]);
      return encode();
    },
    upload:
      upload ||
      (async (file, meta) => {
        uploads.push({ name: file.name, meta });
        return { id: uploads.length, path: `/2026/08/${file.name}` };
      }),
    deleteMedia: async (id) => {
      deletes.push(id);
    },
  };
  if (resolveFont) {
    deps.resolveFont = async () => {
      fontCalls.count++;
      return resolveFont();
    };
  }
  return { deps, log, decodeCalls, closed, uploads, deletes, progress, fontCalls, onProgress: (p) => progress.push(p) };
}

describe('paintSlide', () => {
  test('no pad: clears then blits the column 1:1', () => {
    const log = [];
    const rect = { sx: 10, sy: 0, sw: 100, sh: 200, dx: 0, dy: 0, dw: 1080, dh: 1350 };
    paintSlide(recordingCtx(log), 'BMP', rect, 1080, 1350);
    assert.deepStrictEqual(log, [
      ['clearRect', 0, 0, 1080, 1350],
      ['drawImage', 'BMP', 0, 0, 1080, 1350],
    ]);
  });

  test('pad + solid bg: fills the pad rect from bg.color BEFORE the blit', () => {
    const log = [];
    const rect = { dx: 0, dy: 0, dw: 340, dh: 1350, pad: { x: 340, w: 740 } };
    paintSlide(recordingCtx(log), 'BMP', rect, 1080, 1350, { type: 'solid', color: '#123456' });
    assert.deepStrictEqual(log, [
      ['clearRect', 0, 0, 1080, 1350],
      ['fillStyle', '#123456'],
      ['fillRect', 340, 0, 740, 1350],
      ['drawImage', 'BMP', 0, 0, 340, 1350],
    ]);
  });

  test('pad + blur bg (the default): stretched blurred column under save/restore, then the blit', () => {
    const log = [];
    const rect = { dx: 0, dy: 0, dw: 340, dh: 1350, pad: { x: 340, w: 740 } };
    paintSlide(recordingCtx(log), 'BMP', rect, 1080, 1350, null);
    assert.deepStrictEqual(log, [
      ['clearRect', 0, 0, 1080, 1350],
      ['save'],
      ['filter', 'blur(54px)'],
      ['drawImage', 'BMP', 0, 0, 340, 1350, 0, 0, 1080, 1350],
      ['restore'],
      ['drawImage', 'BMP', 0, 0, 340, 1350],
    ]);
  });

  /** A contained deck slide is letterboxed on two opposite sides at once, so
   *  `pad` is a list of rects — the split path's single full-height column is
   *  only the simplest case of the same fill. */
  test('a letterbox fills every rect the geometry reports, not just a right-hand strip', () => {
    const rect = deckSlideRects(2000, 1000, '1:1', { x: 0, y: 0, w: 1, h: 1 }, 'contain');
    assert.strictEqual(rect.pad.length, 2, 'a bar above and a bar below');

    const log = [];
    paintSlide(recordingCtx(log), 'BMP', rect, 1080, 1080, { type: 'solid', color: '#123456' });
    assert.deepStrictEqual(log, [
      ['clearRect', 0, 0, 1080, 1080],
      ['fillStyle', '#123456'],
      ['fillRect', 0, 0, 1080, 270],
      ['fillRect', 0, 810, 1080, 270],
      ['drawImage', 'BMP', 0, 270, 1080, 540],
    ]);
  });

  test('gradient bg: one gradient across the frame, filled into each pad rect', () => {
    const log = [];
    const rect = { dx: 0, dy: 270, dw: 1080, dh: 540, pad: [
      { x: 0, y: 0, w: 1080, h: 270 },
      { x: 0, y: 810, w: 1080, h: 270 },
    ] };
    paintSlide(recordingCtx(log), 'BMP', rect, 1080, 1080, {
      type: 'gradient',
      angle: 90,
      stops: [
        { at: 0, color: '#000000' },
        { at: 1, color: '#ffffff' },
      ],
    });
    assert.deepStrictEqual(log, [
      ['clearRect', 0, 0, 1080, 1080],
      // 90deg is `to right`, so the axis runs the frame's full width — the same
      // line for both bars, which is what makes them read as one gradient.
      ['createLinearGradient', 0, 540, 1080, 540],
      ['addColorStop', 0, '#000000'],
      ['addColorStop', 1, '#ffffff'],
      ['fillStyle', 'gradient'],
      ['fillRect', 0, 0, 1080, 270],
      ['fillRect', 0, 810, 1080, 270],
      ['drawImage', 'BMP', 0, 270, 1080, 540],
    ]);
  });

  test('a gradient no document normalized falls back to the default fill', () => {
    // `normalizeBg` always writes two stops; a caller that skips it must not be
    // able to throw out of `addColorStop` half way through an encode.
    const rect = { dx: 0, dy: 0, dw: 340, dh: 1350, pad: { x: 340, w: 740 } };
    for (const bg of [
      { type: 'gradient' },
      { type: 'gradient', stops: [] },
      { type: 'gradient', stops: [{ at: 0, color: '#000' }] },
      { type: 'gradient', stops: [{ at: 0, color: '#000' }, { color: '#fff' }] },
    ]) {
      const log = [];
      paintSlide(recordingCtx(log), 'BMP', rect, 1080, 1350, bg);
      assert.deepStrictEqual(
        log.map((e) => e[0]),
        ['clearRect', 'save', 'filter', 'drawImage', 'restore', 'drawImage'],
        `blur fallback for ${JSON.stringify(bg)}`,
      );
    }
  });
});

/** A schema-true text layer: the defaults are the schema's (left/top, white,
 *  weight 400, `size: null` = auto-fit, lineHeight 1.2), so a test that does
 *  not name a field is asserting the default the studio will produce. */
const textLayer = (patch) =>
  normalizeLayer({
    type: 'text',
    text: 'Hello',
    box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
    ...patch,
  });

/** A 1080x1350 no-pad rect: nothing to fill, so the log is the blit and the
 *  layers, and nothing else can be confused for them. */
const FULL_RECT = { sx: 0, sy: 0, sw: 100, sh: 125, dx: 0, dy: 0, dw: 1080, dh: 1350 };

const round1 = (n) => Math.round(n * 10) / 10;

describe('paintSlide — text layers', () => {
  test('no layers: exactly the call sequence from before layers existed', () => {
    const before = [
      ['clearRect', 0, 0, 1080, 1350],
      ['drawImage', 'BMP', 0, 0, 1080, 1350],
    ];
    for (const layers of [undefined, [], null]) {
      const log = [];
      paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, layers, {
        aspect: '4:5',
        font: 'TestFace, sans-serif',
      });
      assert.deepStrictEqual(log, before, `layers=${JSON.stringify(layers)}`);
    }
  });

  test('a text layer is painted after the blit, in its layerRect, auto-fit to the box', () => {
    const layer = textLayer();
    const log = [];
    paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [layer], {
      aspect: '4:5',
      font: 'TestFace, sans-serif',
    });

    assert.deepStrictEqual(log, [
      ['clearRect', 0, 0, 1080, 1350],
      ['drawImage', 'BMP', 0, 0, 1080, 1350],
      ['save'],
      ['fillStyle', '#ffffff'],
      ['textAlign', 'left'],
      ['textBaseline', 'middle'],
      // 864x270 box, one line of 5 half-em glyphs: the height is what binds,
      // so auto-fit lands on 270/1.2 = 225px and the line centres in the box.
      ['fillText', 'Hello', 108, 270, '400 225px TestFace, sans-serif'],
      ['restore'],
    ]);
    const box = layerRect(layer, '4:5');
    assert.strictEqual(painted(log)[0].x, box.x, 'the anchor is the geometry rect, not a local formula');
  });

  test('auto-fit shrinks when the box shrinks', () => {
    const sizeFor = (h) => {
      const log = [];
      paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [textLayer({ box: { x: 0.1, y: 0.1, w: 0.8, h } })], { aspect: '4:5' });
      return painted(log)[0].size;
    };
    assert.strictEqual(sizeFor(0.2), 225);
    assert.strictEqual(sizeFor(0.1), 112, 'half the height, half the type');
    assert.ok(sizeFor(0.1) < sizeFor(0.2));
  });

  test('a numeric size is a fraction of the canvas height, not a pixel count', () => {
    const log = [];
    paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [textLayer({ size: 0.1 })], {
      aspect: '4:5',
      font: 'TestFace',
    });
    const [line] = painted(log);
    assert.strictEqual(line.size, 135, '0.1 of a 1350px canvas');
    // Same layer on a square canvas: the fraction follows the frame, which is
    // the whole reason it is not stored in pixels.
    const square = [];
    paintSlide(recordingCtx(square), 'BMP', FULL_RECT, 1080, 1080, null, [textLayer({ size: 0.1 })], {
      aspect: '1:1',
      font: 'TestFace',
    });
    assert.strictEqual(painted(square)[0].size, 108);
  });

  test('a fixed size wraps to the box width, line by line', () => {
    const log = [];
    const layer = textLayer({ text: 'Hello world here', size: 0.05, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.6 } });
    paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [layer], { aspect: '4:5' });

    const lines = painted(log);
    assert.deepStrictEqual(lines.map((l) => l.text), ['Hello', 'world', 'here']);
    assert.deepStrictEqual(lines.map((l) => l.x), [108, 108, 108], 'left-aligned to the box edge');
    // 68px type, lineHeight 1.2 → an 81.6px line box, each line centred in its own.
    assert.deepStrictEqual(lines.map((l) => round1(l.y)), [175.8, 257.4, 339]);
  });

  test('align and valign place the wrapped block inside the box', () => {
    const log = [];
    const layer = textLayer({
      text: 'Hello world here',
      size: 0.05,
      align: 'center',
      valign: 'middle',
      box: { x: 0.1, y: 0.1, w: 0.2, h: 0.6 },
    });
    paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [layer], { aspect: '4:5' });

    assert.ok(log.some((e) => e[0] === 'textAlign' && e[1] === 'center'));
    const lines = painted(log);
    // 216px box from x=108 → the anchor is its centre; 810px tall box holding a
    // 244.8px block → the block starts half the slack down.
    assert.deepStrictEqual(lines.map((l) => l.x), [216, 216, 216]);
    assert.strictEqual(round1(lines[0].y), round1(135 + (810 - 3 * 68 * 1.2) / 2 + (68 * 1.2) / 2));

    const bottom = [];
    paintSlide(recordingCtx(bottom), 'BMP', FULL_RECT, 1080, 1350, null,
      [normalizeLayer({ ...layer, valign: 'bottom' })], { aspect: '4:5' });
    assert.strictEqual(round1(painted(bottom)[0].y), round1(135 + 810 - 3 * 68 * 1.2 + (68 * 1.2) / 2));
  });

  test('shadow is one fixed preset, scaled by the font size, and off by default', () => {
    const off = [];
    paintSlide(recordingCtx(off), 'BMP', FULL_RECT, 1080, 1350, null, [textLayer()], { aspect: '4:5' });
    assert.deepStrictEqual(off.filter((e) => String(e[0]).startsWith('shadow')), []);

    const on = [];
    paintSlide(recordingCtx(on), 'BMP', FULL_RECT, 1080, 1350, null, [textLayer({ shadow: true })], { aspect: '4:5' });
    assert.deepStrictEqual(
      on
        .filter((e) => String(e[0]).startsWith('shadow'))
        .map(([k, v]) => [k, typeof v === 'number' ? round1(v) : v]),
      [
        ['shadowColor', 'rgba(0, 0, 0, 0.55)'],
        ['shadowBlur', 36],
        ['shadowOffsetY', 11.3],
      ],
    );
  });

  test('colour and weight come from the layer', () => {
    const log = [];
    paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null,
      [textLayer({ color: '#ff0088', weight: 700 })], { aspect: '4:5', font: 'TestFace' });
    assert.ok(log.some((e) => e[0] === 'fillStyle' && e[1] === '#ff0088'));
    assert.strictEqual(painted(log)[0].font, '700 225px TestFace');
  });

  test('blank text paints nothing at all', () => {
    for (const text of ['', '   ', '\n\t']) {
      const log = [];
      paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [textLayer({ text })], { aspect: '4:5' });
      assert.deepStrictEqual(painted(log), [], JSON.stringify(text));
    }
  });

  test('layers paint back to front, and a type this build cannot draw is skipped', () => {
    const log = [];
    paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [
      textLayer({ text: 'under' }),
      // `.4` paints these; until then they are skipped, not half-drawn.
      normalizeLayer({ type: 'rect', box: { x: 0, y: 0, w: 1, h: 1 } }),
      textLayer({ text: 'over' }),
    ], { aspect: '4:5' });
    assert.deepStrictEqual(painted(log).map((l) => l.text), ['under', 'over']);
  });

  test('no font resolved: the built-in stack, not a throw', () => {
    for (const font of [undefined, '', null]) {
      const log = [];
      paintSlide(recordingCtx(log), 'BMP', FULL_RECT, 1080, 1350, null, [textLayer()], { aspect: '4:5', font });
      assert.match(painted(log)[0].font, /Inter/, `font=${JSON.stringify(font)}`);
    }
  });
});

describe('renderSplit', () => {
  test('one crop-and-resize decode per slide, painted + closed, progress once per slide', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const blobs = await renderSplit(
      { source: '/2026/08/wide.jpg', n: 3, aspect: '4:5' },
      f.deps,
      f.onProgress,
    );

    assert.strictEqual(blobs.length, 3);
    assert.strictEqual(f.closed.count, 3, 'every bitmap closed');
    assert.deepStrictEqual(f.progress, [
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);

    const [w, h] = canvasSize('4:5');
    const rects = sliceRects(3000, 1000, 3, '4:5', {});
    // The decode call carries the exact source crop rect and resizes straight
    // to the slide column, so the blit is 1:1.
    assert.deepStrictEqual(
      f.decodeCalls.map((o) => [o.sx, o.sy, o.sw, o.sh, o.resizeWidth, o.resizeHeight]),
      rects.map((r) => [r.sx, r.sy, r.sw, r.sh, r.dw, r.dh]),
    );
    assert.ok(f.decodeCalls.every((o) => o.resizeQuality === 'high'));

    const draws = f.log.filter((e) => e[0] === 'drawImage').map((e) => e.slice(2));
    assert.deepStrictEqual(draws, rects.map((r) => [r.dx, r.dy, r.dw, r.dh]));
    assert.deepStrictEqual(
      f.log.filter((e) => e[0] === 'clearRect'),
      rects.map(() => ['clearRect', 0, 0, w, h]),
    );
  });

  test('a 4096-wide source at `exact` decodes 1080px columns at scale 1 — the old cap regression', async () => {
    const f = fakeDeps({ srcW: 4096, srcH: 1400 });
    await renderSplit(
      { source: '/x.jpg', n: 3, aspect: '4:5', strategy: 'exact' },
      f.deps,
    );
    assert.strictEqual(f.decodeCalls.length, 3, 'floor(4096/1080) = 3 slides');
    for (const o of f.decodeCalls) {
      assert.strictEqual(o.sw, 1080, 'source column is a full canvas wide');
      assert.strictEqual(o.resizeWidth, 1080, 'resampled 1:1, not downscaled under a 4096 cap');
    }
  });

  test('`pad` fills before it blits on the short tail slide', async () => {
    const f = fakeDeps({ srcW: 2500, srcH: 1400 });
    await renderSplit(
      { source: '/x.jpg', n: 3, aspect: '4:5', strategy: 'pad', bg: { type: 'solid', color: '#abcdef' } },
      f.deps,
    );
    const rects = sliceRects(2500, 1400, 3, '4:5', { strategy: 'pad' });
    assert.ok(rects[2].pad, 'geometry produced a pad rect for slide 3');

    // The only fillRect in the run belongs to the tail slide, and it precedes
    // that slide's drawImage.
    const fillAt = f.log.findIndex((e) => e[0] === 'fillRect');
    const lastDrawAt = f.log.map((e) => e[0]).lastIndexOf('drawImage');
    assert.ok(fillAt !== -1 && fillAt < lastDrawAt, 'pad fill comes before the final blit');
    assert.deepStrictEqual(
      f.log[fillAt],
      ['fillRect', rects[2].pad.x, 0, rects[2].pad.w, 1350],
    );
  });

  test('anchorY threads through to geometry', async () => {
    const f = fakeDeps({ srcW: 2000, srcH: 3000 });
    await renderSplit({ source: '/x.jpg', n: 2, aspect: '1:1', anchorY: 0 }, f.deps);
    const top = sliceRects(2000, 3000, 2, '1:1', { anchorY: 0 });
    assert.strictEqual(f.decodeCalls[0].sy, top[0].sy);
  });

  test('a null from the encoder is a hard error, not a skipped slide', async () => {
    const { deps } = fakeDeps({ encode: () => null });
    await assert.rejects(
      () => renderSplit({ source: '/x.jpg', n: 2, aspect: '1:1' }, deps),
      /toBlob returned null/,
    );
  });

  test('closes the bitmap even when a slide fails', async () => {
    const { deps, closed } = fakeDeps({ encode: () => null });
    await renderSplit({ source: '/x.jpg', n: 2, aspect: '1:1' }, deps).catch(() => {});
    assert.strictEqual(closed.count, 1, 'the one decoded bitmap is closed before the throw');
  });

  test('skips the probe when the caller already knows the source size', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    await renderSplit(
      { source: '/x.jpg', n: 2, aspect: '4:5', srcW: 3000, srcH: 1000 },
      f.deps,
    );
    assert.ok(!f.log.some((e) => e[0] === 'probeSize'), 'probeSize not called');
  });
});

/** A deck document: `n` slides of one source, frozen from a split, so the crops
 *  are exactly the columns `sliceRects` was deriving. */
function deckOf(source, n, aspect, srcW, srcH) {
  return toDeckDocument(splitDocument({ source, n, aspect }), srcW, srcH);
}

const urlsOf = (log, name) => log.filter((e) => e[0] === name).map((e) => e[1]);

describe('renderDeck', () => {
  test('fetches and probes once per unique source, not once per slide', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const blobs = await renderDeck(deckOf('/2026/08/wide.jpg', 4, '4:5', 3000, 1000), f.deps, f.onProgress);

    assert.strictEqual(blobs.length, 4);
    assert.deepStrictEqual(urlsOf(f.log, 'fetchBlob'), ['/2026/08/wide.jpg'], 'one GET for the whole deck');
    assert.deepStrictEqual(urlsOf(f.log, 'probeSize'), ['/2026/08/wide.jpg'], 'one probe for the whole deck');
    assert.strictEqual(f.closed.count, 4, 'every bitmap closed — one alive at a time');
    assert.deepStrictEqual(f.progress, [
      { done: 1, total: 4 },
      { done: 2, total: 4 },
      { done: 3, total: 4 },
      { done: 4, total: 4 },
    ]);
  });

  test('a deck of two images fetches and probes each one exactly once', async () => {
    const f = fakeDeps();
    const doc = normalizeDocument({
      mode: 'deck',
      aspect: '4:5',
      slides: [{ source: '/a.jpg' }, { source: '/b.jpg' }, { source: '/a.jpg' }],
    });
    await renderDeck(doc, f.deps);

    assert.deepStrictEqual(urlsOf(f.log, 'fetchBlob'), ['/a.jpg', '/b.jpg']);
    assert.deepStrictEqual(urlsOf(f.log, 'probeSize'), ['/a.jpg', '/b.jpg']);
    assert.strictEqual(f.decodeCalls.length, 3, 'still one decode per slide');
  });

  test('each slide decodes its own crop from geometry, resized straight to the frame', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = deckOf('/x.jpg', 3, '4:5', 3000, 1000);
    await renderDeck(doc, f.deps);

    const rects = doc.slides.map((s) => deckSlideRects(3000, 1000, '4:5', s.crop, s.fit));
    assert.deepStrictEqual(
      f.decodeCalls.map((o) => [o.sx, o.sy, o.sw, o.sh, o.resizeWidth, o.resizeHeight]),
      rects.map((r) => [r.sx, r.sy, r.sw, r.sh, r.dw, r.dh]),
    );
    assert.ok(f.decodeCalls.every((o) => o.resizeQuality === 'high'));

    const [w, h] = canvasSize('4:5');
    assert.deepStrictEqual(
      f.log.filter((e) => e[0] === 'drawImage').map((e) => e.slice(2)),
      rects.map((r) => [r.dx, r.dy, r.dw, r.dh]),
    );
    assert.deepStrictEqual(
      f.log.filter((e) => e[0] === 'clearRect'),
      rects.map(() => ['clearRect', 0, 0, w, h]),
    );
  });

  test("a contained slide's own bg fills its letterbox, slide by slide", async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const base = deckOf('/x.jpg', 3, '4:5', 3000, 1000);
    // Slide 1 alone is letterboxed, and carries a solid fill; the others cover.
    const doc = normalizeDocument({
      ...base,
      slides: base.slides.map((s, i) =>
        i === 1
          ? { ...s, crop: { x: 0, y: 0, w: 1, h: 1 }, fit: 'contain', bg: { type: 'solid', color: '#abcdef' } }
          : s,
      ),
    });
    await renderDeck(doc, f.deps, undefined, undefined, { srcW: 3000, srcH: 1000 });

    const pad = deckSlideRects(3000, 1000, '4:5', doc.slides[1].crop, 'contain').pad;
    assert.ok(pad.length >= 2, 'the contained slide really is letterboxed');
    assert.deepStrictEqual(
      f.log.filter((e) => e[0] === 'fillStyle' || e[0] === 'fillRect'),
      [
        ['fillStyle', '#abcdef'],
        ...pad.map((p) => ['fillRect', p.x, p.y, p.w, p.h]),
      ],
      'exactly one slide fills, and it fills every bar of its own letterbox',
    );
  });

  test('a kept slide skips decode and encode, leaves a null slot, and still reports progress', async () => {
    const f = fakeDeps();
    const keep = [null, { id: 900, path: '/2026/08/kept.jpg' }, null];
    const blobs = await renderDeck(deckOf('/x.jpg', 3, '4:5', 3000, 1000), f.deps, f.onProgress, keep);

    assert.strictEqual(blobs[1], null, 'the kept slot is null, not a blob');
    assert.strictEqual(f.decodeCalls.length, 2);
    assert.strictEqual(f.log.filter((e) => e[0] === 'encode').length, 2);
    assert.strictEqual(f.progress.length, 3, 'progress fires for skipped slides too');
  });

  test('a deck where every slide is kept never touches the network', async () => {
    const f = fakeDeps();
    const keep = [{ id: 1, path: '/a' }, { id: 2, path: '/b' }];
    const blobs = await renderDeck(deckOf('/x.jpg', 2, '4:5', 3000, 1000), f.deps, undefined, keep);

    assert.deepStrictEqual(blobs, [null, null]);
    assert.deepStrictEqual(f.log, [], 'no fetch, no probe, no decode');
  });

  test('a null from the encoder is a hard error, and the bitmap is still closed', async () => {
    const f = fakeDeps({ encode: () => null });
    await assert.rejects(
      () => renderDeck(deckOf('/x.jpg', 2, '4:5', 3000, 1000), f.deps),
      /toBlob returned null/,
    );
    assert.strictEqual(f.closed.count, 1, 'the one decoded bitmap is closed before the throw');
  });

  test('a caller-known source size skips the probe when the whole deck shares one source', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    await renderDeck(deckOf('/x.jpg', 3, '4:5', 3000, 1000), f.deps, undefined, undefined, {
      srcW: 3000,
      srcH: 1000,
    });
    assert.deepStrictEqual(urlsOf(f.log, 'probeSize'), [], 'probeSize not called');
  });

  test('a caller-known size is ignored for a multi-source deck — it names no source', async () => {
    const f = fakeDeps();
    const doc = normalizeDocument({
      mode: 'deck',
      aspect: '4:5',
      slides: [{ source: '/a.jpg' }, { source: '/b.jpg' }],
    });
    await renderDeck(doc, f.deps, undefined, undefined, { srcW: 3000, srcH: 1000 });
    assert.deepStrictEqual(urlsOf(f.log, 'probeSize'), ['/a.jpg', '/b.jpg'], 'both probed');
  });

  test('a source with no pixel dimensions is a hard error, not a 0x0 decode', async () => {
    const f = fakeDeps({ srcW: 0, srcH: 0 });
    await assert.rejects(
      () => renderDeck(deckOf('/x.jpg', 2, '4:5', 3000, 1000), f.deps),
      /no pixel dimensions/,
    );
    assert.strictEqual(f.decodeCalls.length, 0);
  });
});

describe('renderCarousel', () => {
  test('a split document goes down the split path, with the doc-level framing', async () => {
    const f = fakeDeps({ srcW: 4096, srcH: 1400 });
    const doc = splitDocument({ source: '/x.jpg', n: 3, aspect: '4:5', strategy: 'exact', anchorY: 0 });
    await renderCarousel(doc, f.deps);

    const rects = sliceRects(4096, 1400, 3, '4:5', { strategy: 'exact', anchorY: 0 });
    assert.deepStrictEqual(
      f.decodeCalls.map((o) => [o.sx, o.sy, o.sw, o.sh]),
      rects.map((r) => [r.sx, r.sy, r.sw, r.sh]),
    );
  });

  test('the split path takes its background from the last slide — the only one that can pad', async () => {
    const f = fakeDeps({ srcW: 2500, srcH: 1400 });
    const doc = splitDocument({ source: '/x.jpg', n: 3, aspect: '4:5', strategy: 'pad' });
    doc.slides[doc.slides.length - 1].bg = { type: 'solid', color: '#abcdef' };
    await renderCarousel(doc, f.deps);

    const pad = sliceRects(2500, 1400, 3, '4:5', { strategy: 'pad' })[2].pad;
    const fillAt = f.log.findIndex((e) => e[0] === 'fillRect');
    assert.deepStrictEqual(f.log[fillAt - 1], ['fillStyle', '#abcdef']);
    assert.deepStrictEqual(f.log[fillAt], ['fillRect', pad.x, 0, pad.w, 1350]);
  });

  test('a deck document goes down the deck path, one rect per slide crop', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = deckOf('/x.jpg', 3, '4:5', 3000, 1000);
    const blobs = await renderCarousel(doc, f.deps);

    assert.strictEqual(blobs.length, 3);
    assert.deepStrictEqual(urlsOf(f.log, 'fetchBlob'), ['/x.jpg'], 'the deck path deduped the fetch');
    assert.deepStrictEqual(
      f.decodeCalls.map((o) => [o.sx, o.sy, o.sw, o.sh]),
      doc.slides
        .map((s) => deckSlideRects(3000, 1000, '4:5', s.crop, s.fit))
        .map((r) => [r.sx, r.sy, r.sw, r.sh]),
    );
  });

  test('a document with no slides renders nothing and fetches nothing', async () => {
    const f = fakeDeps();
    assert.deepStrictEqual(await renderCarousel(normalizeDocument({ slides: [] }), f.deps), []);
    assert.deepStrictEqual(f.log, []);
  });

  test('a caller-known source size skips the probe on the split path too', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = splitDocument({ source: '/x.jpg', n: 2, aspect: '4:5' });
    await renderCarousel(doc, f.deps, undefined, undefined, { srcW: 3000, srcH: 1000 });
    assert.deepStrictEqual(urlsOf(f.log, 'probeSize'), []);
  });
});

/**
 * Layers through both sequencers. The rule the whole S3 render path rests on is
 * the negative one: a slide carrying no layers must issue the calls it issued
 * before layers existed, or the S1/S2 renders stop being byte-identical and
 * every stored `specHash` starts lying about what is on disk.
 */
describe('layers through the sequencers', () => {
  test('a deck slide paints its own layers, after the blit, and only its own', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = deckOf('/x.jpg', 2, '4:5', 3000, 1000);
    doc.slides[0].layers = [textLayer({ text: 'One' })];
    await renderDeck(doc, f.deps);

    const [first, second] = surfaces(f.log);
    assert.deepStrictEqual(painted(first).map((l) => l.text), ['One']);
    assert.deepStrictEqual(painted(second), [], 'a layer belongs to its slide, not to the deck');
    assert.ok(
      first.findIndex((e) => e[0] === 'drawImage') < first.findIndex((e) => e[0] === 'fillText'),
      'the image is blitted before any type is set over it',
    );
  });

  test('a slide with no layers encodes exactly what it encoded before layers existed', async () => {
    const withLayer = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = deckOf('/x.jpg', 2, '4:5', 3000, 1000);
    doc.slides[0].layers = [textLayer()];
    await renderDeck(doc, withLayer.deps);

    const bare = fakeDeps({ srcW: 3000, srcH: 1000 });
    await renderDeck(deckOf('/x.jpg', 2, '4:5', 3000, 1000), bare.deps);

    // The decoded bitmap is a fresh fake per render, so compare it by shape:
    // what is under test is the call sequence, which is what the encoder sees.
    const shape = (seg) => seg.map((e) => e.map((v) => (v && typeof v === 'object' ? 'BMP' : v)));
    assert.deepStrictEqual(shape(surfaces(withLayer.log)[1]), shape(surfaces(bare.log)[1]));
  });

  test('layers are not deck-only: the split path paints them too', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = splitDocument({ source: '/x.jpg', n: 2, aspect: '4:5' });
    doc.slides[1].layers = [textLayer({ text: 'Two' })];
    await renderCarousel(doc, f.deps);

    const [first, second] = surfaces(f.log);
    assert.deepStrictEqual(painted(first), []);
    assert.deepStrictEqual(painted(second).map((l) => l.text), ['Two']);
  });

  test('the theme font is resolved once for the whole render, and only when something needs it', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = deckOf('/x.jpg', 3, '4:5', 3000, 1000);
    for (const slide of doc.slides) slide.layers = [textLayer()];
    await renderDeck(doc, f.deps);

    assert.strictEqual(f.fontCalls.count, 1, 'one await on document.fonts.ready per render');
    assert.deepStrictEqual(
      painted(f.log).map((l) => l.font),
      Array(3).fill('400 225px TestFace, sans-serif'),
    );

    const bare = fakeDeps({ srcW: 3000, srcH: 1000 });
    await renderDeck(deckOf('/x.jpg', 3, '4:5', 3000, 1000), bare.deps);
    assert.strictEqual(bare.fontCalls.count, 0, 'a deck with no layers never waits on a font');
  });

  test('a font that cannot be resolved falls back rather than failing the encode', async () => {
    const cases = {
      'no resolveFont dep at all': null,
      'a dep that returns nothing usable': async () => '  ',
      'a dep that throws': async () => {
        throw new Error('fonts unavailable');
      },
    };
    for (const [name, resolveFont] of Object.entries(cases)) {
      const f = fakeDeps({ srcW: 3000, srcH: 1000, resolveFont });
      const doc = deckOf('/x.jpg', 1, '4:5', 3000, 1000);
      doc.slides[0].layers = [textLayer()];
      const blobs = await renderDeck(doc, f.deps);

      assert.strictEqual(blobs.length, 1, name);
      assert.match(painted(f.log)[0].font, /Inter/, name);
    }
  });

  test('a kept slide paints nothing, layers included', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const doc = deckOf('/x.jpg', 2, '4:5', 3000, 1000);
    for (const slide of doc.slides) slide.layers = [textLayer()];
    await renderDeck(doc, f.deps, undefined, [{ id: 7, path: '/kept.jpg' }, null]);

    assert.strictEqual(surfaces(f.log).length, 1, 'one canvas, for the slide that was re-encoded');
    assert.strictEqual(painted(f.log).length, 1);
  });
});

describe('renderAndUpload', () => {
  test('uploads each slide with post_id set, in deck order, forwarding progress', async () => {
    const f = fakeDeps();
    const media = await renderAndUpload(
      { source: '/2026/08/wide.jpg', n: 3, aspect: '4:5', postId: 42 },
      f.deps,
      f.onProgress,
    );

    assert.deepStrictEqual(
      f.uploads.map((u) => u.name),
      ['carousel-42-1.jpg', 'carousel-42-2.jpg', 'carousel-42-3.jpg'],
    );
    assert.ok(f.uploads.every((u) => u.meta.post_id === 42));
    assert.deepStrictEqual(
      media.map((m) => m.path),
      ['/2026/08/carousel-42-1.jpg', '/2026/08/carousel-42-2.jpg', '/2026/08/carousel-42-3.jpg'],
    );
    assert.strictEqual(f.progress.length, 3);
  });

  test('a kept slide is neither decoded nor uploaded, and its media row is reused verbatim', async () => {
    const f = fakeDeps();
    const keep = [null, { id: 900, path: '/2026/08/kept.jpg' }, null];
    const media = await renderAndUpload(
      { source: '/2026/08/wide.jpg', n: 3, aspect: '4:5', postId: 42 },
      f.deps,
      f.onProgress,
      keep,
    );

    assert.strictEqual(f.decodeCalls.length, 2, 'the kept slide skips decode');
    assert.deepStrictEqual(f.uploads.map((u) => u.name), ['carousel-42-1.jpg', 'carousel-42-3.jpg']);
    assert.deepStrictEqual(
      media.map((m) => m.id),
      [1, 900, 2],
    );
    assert.strictEqual(f.progress.length, 3, 'progress still fires once per slide, kept or not');
  });

  test('a mid-loop upload failure deletes every slide this run already uploaded', async () => {
    let calls = 0;
    const f = fakeDeps({
      upload: async (file) => {
        calls += 1;
        if (calls === 3) throw new Error('upload failed');
        return { id: calls, path: `/2026/08/${file.name}` };
      },
    });

    await assert.rejects(
      () =>
        renderAndUpload(
          { source: '/2026/08/wide.jpg', n: 4, aspect: '4:5', postId: 42 },
          f.deps,
        ),
      /upload failed/,
    );

    assert.deepStrictEqual(f.deletes.sort(), [1, 2], 'the two slides uploaded before the failure are removed');
  });

  test('a mid-loop upload failure never deletes a kept (reused) slide', async () => {
    let calls = 0;
    const f = fakeDeps({
      upload: async (file) => {
        calls += 1;
        if (calls === 2) throw new Error('upload failed');
        return { id: 100 + calls, path: `/2026/08/${file.name}` };
      },
    });
    const keep = [{ id: 900, path: '/2026/08/kept.jpg' }, null, null];

    await assert.rejects(
      () =>
        renderAndUpload(
          { source: '/2026/08/wide.jpg', n: 3, aspect: '4:5', postId: 42 },
          f.deps,
          undefined,
          keep,
        ),
      /upload failed/,
    );

    assert.deepStrictEqual(f.deletes, [101], 'only the fresh upload is deleted, not the kept row');
  });

  test('a { doc, postId } spec renders the document and uploads it the same way', async () => {
    const f = fakeDeps({ srcW: 3000, srcH: 1000 });
    const media = await renderAndUpload(
      { doc: deckOf('/2026/08/wide.jpg', 3, '4:5', 3000, 1000), postId: 42, srcW: 3000, srcH: 1000 },
      f.deps,
      f.onProgress,
    );

    assert.deepStrictEqual(urlsOf(f.log, 'probeSize'), [], 'the known size threads through the facade');
    assert.deepStrictEqual(
      f.uploads.map((u) => u.name),
      ['carousel-42-1.jpg', 'carousel-42-2.jpg', 'carousel-42-3.jpg'],
    );
    assert.ok(f.uploads.every((u) => u.meta.post_id === 42));
    assert.deepStrictEqual(media.map((m) => m.id), [1, 2, 3]);
    assert.strictEqual(f.progress.length, 3);
  });

  test('a doc-shaped spec unwinds a partial upload failure like the flat one', async () => {
    let calls = 0;
    const f = fakeDeps({
      upload: async (file) => {
        calls += 1;
        if (calls === 3) throw new Error('upload failed');
        return { id: calls, path: `/2026/08/${file.name}` };
      },
    });

    await assert.rejects(
      () =>
        renderAndUpload(
          { doc: deckOf('/x.jpg', 4, '4:5', 3000, 1000), postId: 7 },
          f.deps,
        ),
      /upload failed/,
    );
    assert.deepStrictEqual(f.deletes.sort(), [1, 2]);
  });
});
