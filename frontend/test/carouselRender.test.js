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
import { sliceRects, deckSlideRects, canvasSize } from '../src/plugins/carousel/geometry.js';
import {
  normalizeDocument,
  splitDocument,
  toDeckDocument,
} from '../src/plugins/carousel/document.js';

/** A ctx that records every call and style assignment as `[name, ...args]`. */
function recordingCtx(log) {
  const ctx = {
    clearRect: (...a) => log.push(['clearRect', ...a]),
    drawImage: (...a) => log.push(['drawImage', ...a]),
    fillRect: (...a) => log.push(['fillRect', ...a]),
    save: () => log.push(['save']),
    restore: () => log.push(['restore']),
  };
  for (const prop of ['fillStyle', 'filter']) {
    let v;
    Object.defineProperty(ctx, prop, {
      get: () => v,
      set: (next) => {
        v = next;
        log.push([prop, next]);
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
function fakeDeps({ srcW = 3000, srcH = 1000, encode = () => new Blob(['jpg']), upload } = {}) {
  const log = [];
  const decodeCalls = [];
  const closed = { count: 0 };
  const uploads = [];
  const deletes = [];
  const progress = [];
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
  return { deps, log, decodeCalls, closed, uploads, deletes, progress, onProgress: (p) => progress.push(p) };
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
