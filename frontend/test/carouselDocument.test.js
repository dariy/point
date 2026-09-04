/**
 * carousel/document.js — the carousel document model.
 *
 * The stored JSON is the source of truth; the `:::{.carousel-block}` in post
 * content is regenerated output. These tests pin normalization (defaults,
 * clamping, unknown-field drop), the parse/serialize round trip, the block
 * writer's blank-line contract, and specHash's change detection.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  DOC_VERSION,
  emptyDocument,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  buildCarouselBlock,
  applyCarouselBlock,
  splitDocument,
  toDeckDocument,
  updateSlideFraming,
  specHash,
} from '../src/plugins/carousel/document.js';
import {
  canvasSize,
  sliceRects,
  deckSlideRects,
} from '../src/plugins/carousel/geometry.js';

describe('normalizeDocument', () => {
  test('an empty input becomes the default document', () => {
    assert.deepStrictEqual(normalizeDocument({}), {
      version: DOC_VERSION,
      aspect: '4:5',
      mode: 'split',
      strategy: 'cover',
      anchorY: 0.5,
      slides: [],
      spanLayers: [],
      template: null,
    });
    assert.deepStrictEqual(emptyDocument(), normalizeDocument({}));
  });

  test('is idempotent', () => {
    const doc = {
      aspect: '1:1',
      mode: 'deck',
      slides: [{ source: '/2026/08/a.jpg', fit: 'contain', bg: { type: 'blur' } }],
      spanLayers: [{ type: 'rect' }],
      template: { id: 'cover-3', custom: true },
    };
    const once = normalizeDocument(doc);
    assert.deepStrictEqual(normalizeDocument(once), once);
  });

  test('unknown enum values fall back to defaults', () => {
    const d = normalizeDocument({ aspect: 'nope', mode: 'nope', slides: [{ fit: 'nope' }] });
    assert.strictEqual(d.aspect, '4:5');
    assert.strictEqual(d.mode, 'split');
    assert.strictEqual(d.slides[0].fit, 'cover');
  });

  test('version is always the current schema version', () => {
    assert.strictEqual(normalizeDocument({ version: 99 }).version, DOC_VERSION);
  });

  test('crop is clamped into the source', () => {
    const [wide] = normalizeDocument({ slides: [{ crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }] }).slides;
    assert.deepStrictEqual(wide.crop, { x: 0.5, y: 0, w: 0.5, h: 1 });

    const [neg] = normalizeDocument({ slides: [{ crop: { x: -1, y: -1, w: 2, h: 2 } }] }).slides;
    assert.deepStrictEqual(neg.crop, { x: 0, y: 0, w: 1, h: 1 });

    const [missing] = normalizeDocument({ slides: [{}] }).slides;
    assert.deepStrictEqual(missing.crop, { x: 0, y: 0, w: 1, h: 1 });
  });

  test('bg keeps a known type and drops an unknown one', () => {
    assert.deepStrictEqual(
      normalizeDocument({ slides: [{ bg: { type: 'solid', color: '#fff' } }] }).slides[0].bg,
      { type: 'solid', color: '#fff' },
    );
    assert.strictEqual(normalizeDocument({ slides: [{ bg: { type: 'wat' } }] }).slides[0].bg, null);
    assert.strictEqual(normalizeDocument({ slides: [{ bg: 'blur' }] }).slides[0].bg, null);
  });

  test('rendered needs a path, and fills media_id / specHash', () => {
    assert.strictEqual(
      normalizeDocument({ slides: [{ rendered: { media_id: 3 } }] }).slides[0].rendered,
      null,
    );
    assert.deepStrictEqual(
      normalizeDocument({ slides: [{ rendered: { path: '/2026/08/s.jpg' } }] }).slides[0].rendered,
      { path: '/2026/08/s.jpg', media_id: null, specHash: '' },
    );
  });

  test('template needs an id, and custom is coerced to a boolean', () => {
    assert.strictEqual(normalizeDocument({ template: { custom: true } }).template, null);
    assert.deepStrictEqual(normalizeDocument({ template: { id: 't', custom: 1 } }).template, {
      id: 't',
      custom: true,
    });
  });
});

describe('doc-level strategy / anchorY', () => {
  test('default in: cover, centred', () => {
    const d = normalizeDocument({});
    assert.strictEqual(d.strategy, 'cover');
    assert.strictEqual(d.anchorY, 0.5);
  });

  test('an unknown strategy falls back to cover; a known one is kept', () => {
    assert.strictEqual(normalizeDocument({ strategy: 'nope' }).strategy, 'cover');
    assert.strictEqual(normalizeDocument({ strategy: 'exact' }).strategy, 'exact');
    assert.strictEqual(normalizeDocument({ strategy: 'pad' }).strategy, 'pad');
  });

  test('anchorY is coerced to a number and clamped to 0..1', () => {
    assert.strictEqual(normalizeDocument({ anchorY: 0.25 }).anchorY, 0.25);
    assert.strictEqual(normalizeDocument({ anchorY: -3 }).anchorY, 0);
    assert.strictEqual(normalizeDocument({ anchorY: 9 }).anchorY, 1);
    assert.strictEqual(normalizeDocument({ anchorY: 'x' }).anchorY, 0.5);
  });

  test('round trip: parse(serialize(doc)) === normalize(doc)', () => {
    const doc = { strategy: 'pad', anchorY: 0.2, slides: [{ source: '/a.jpg' }] };
    assert.deepStrictEqual(parseDocument(serializeDocument(doc)), normalizeDocument(doc));
  });

  test('an old document with neither field still parses (additive, DOC_VERSION 1)', () => {
    const legacy = '{"version":1,"aspect":"1:1","mode":"split","slides":[]}';
    const d = parseDocument(legacy);
    assert.strictEqual(d.version, DOC_VERSION);
    assert.strictEqual(d.strategy, 'cover');
    assert.strictEqual(d.anchorY, 0.5);
  });
});

describe('parse / serialize', () => {
  test('null, undefined and "" all parse to an empty document', () => {
    assert.deepStrictEqual(parseDocument(null), emptyDocument());
    assert.deepStrictEqual(parseDocument(undefined), emptyDocument());
    assert.deepStrictEqual(parseDocument(''), emptyDocument());
  });

  test('a malformed JSON string throws rather than losing the document', () => {
    assert.throws(() => parseDocument('{not json'));
  });

  test('round trip: parse(serialize(doc)) === normalize(doc)', () => {
    const doc = {
      version: 1,
      aspect: '1:1',
      mode: 'deck',
      slides: [
        {
          source: '/2026/08/a.jpg',
          crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
          fit: 'contain',
          bg: { type: 'blur' },
          layers: [{ type: 'text', text: 'hi' }],
          rendered: { path: '/2026/08/s1.jpg', media_id: 5, specHash: 'abc' },
        },
      ],
      spanLayers: [{ type: 'rect', x: 1 }],
      template: { id: 'cover-3', custom: false },
    };
    assert.deepStrictEqual(parseDocument(serializeDocument(doc)), normalizeDocument(doc));
  });

  test('identical documents serialize to identical strings', () => {
    const a = serializeDocument({ mode: 'deck', aspect: '1:1' });
    const b = serializeDocument({ aspect: '1:1', mode: 'deck' });
    assert.strictEqual(a, b);
  });

  test('parse accepts an already-parsed object', () => {
    assert.strictEqual(parseDocument({ aspect: '1.91:1' }).aspect, '1.91:1');
  });
});

describe('buildCarouselBlock', () => {
  test('one bare path per rendered slide, blank line between, in slide order', () => {
    const doc = {
      slides: [
        { rendered: { path: '/2026/08/1.jpg' } },
        { source: '/2026/08/raw.jpg' }, // not rendered yet — skipped
        { rendered: { path: '/2026/08/3.jpg' } },
      ],
    };
    assert.strictEqual(
      buildCarouselBlock(doc),
      ':::{.carousel-block}\n\n/2026/08/1.jpg\n\n/2026/08/3.jpg\n\n:::',
    );
  });

  test('no rendered slides -> empty string', () => {
    assert.strictEqual(buildCarouselBlock({ slides: [{ source: '/x' }] }), '');
    assert.strictEqual(buildCarouselBlock({}), '');
  });
});

describe('splitDocument', () => {
  test('n slides, all from the one source, split mode', () => {
    const doc = splitDocument({ source: '/2026/08/wide.jpg', n: 3, aspect: '1:1' });
    assert.strictEqual(doc.mode, 'split');
    assert.strictEqual(doc.aspect, '1:1');
    assert.strictEqual(doc.slides.length, 3);
    assert.ok(doc.slides.every((s) => s.source === '/2026/08/wide.jpg'));
    assert.ok(doc.slides.every((s) => s.rendered === null));
  });

  test('an unknown aspect falls back to 4:5, n<2 to a single slide', () => {
    const doc = splitDocument({ source: '/x.jpg', n: 0, aspect: 'nope' });
    assert.strictEqual(doc.aspect, '4:5');
    assert.strictEqual(doc.slides.length, 1);
  });

  test('each slide gets a distinct specHash (its own source band)', () => {
    const doc = splitDocument({ source: '/2026/08/wide.jpg', n: 4, aspect: '4:5' });
    const hashes = doc.slides.map((s) => specHash(s, doc.aspect));
    assert.strictEqual(new Set(hashes).size, 4);
  });

  test('carries the strategy and anchorY through to the document', () => {
    const doc = splitDocument({
      source: '/x.jpg',
      n: 3,
      aspect: '4:5',
      strategy: 'pad',
      anchorY: 0.1,
    });
    assert.strictEqual(doc.strategy, 'pad');
    assert.strictEqual(doc.anchorY, 0.1);
  });

  test('an unknown strategy / out-of-range anchorY fall back', () => {
    const doc = splitDocument({ source: '/x.jpg', n: 2, aspect: '4:5', strategy: 'nope', anchorY: 5 });
    assert.strictEqual(doc.strategy, 'cover');
    assert.strictEqual(doc.anchorY, 1);
  });
});

describe('toDeckDocument', () => {
  const SRC = '/2026/08/wide.jpg';

  test('every slide keeps its source and gains the crop it was already showing', () => {
    const split = splitDocument({ source: SRC, n: 3, aspect: '4:5' });
    const deck = toDeckDocument(split, 4000, 1500);
    assert.strictEqual(deck.mode, 'deck');
    assert.strictEqual(deck.slides.length, 3);
    assert.ok(deck.slides.every((s) => s.source === SRC));
    assert.ok(deck.slides.every((s) => s.fit === 'cover'));
    // The naive bands splitDocument wrote (x = i/n, w = 1/n, full frame) are
    // replaced by the real projection: three 4:5 slides use a 3600px centred
    // strip of this 4000px source, so the deck starts 200px in and each column
    // is narrower than a third.
    assert.strictEqual(split.slides[0].crop.x, 0);
    assert.strictEqual(deck.slides[0].crop.x, 200 / 4000);
    assert.ok(deck.slides.every((s) => s.crop.w < 1 / 3));
    assert.ok(deck.slides[0].crop.x < deck.slides[1].crop.x);
  });

  test('the input document is not mutated', () => {
    const split = splitDocument({ source: SRC, n: 3, aspect: '4:5' });
    const before = serializeDocument(split);
    toDeckDocument(split, 4000, 1500);
    assert.strictEqual(serializeDocument(split), before);
    assert.strictEqual(split.mode, 'split');
  });

  test('strategy and anchorY stay on the document (a return to split needs them)', () => {
    const split = splitDocument({ source: SRC, n: 3, aspect: '1:1', strategy: 'pad', anchorY: 0.2 });
    const deck = toDeckDocument(split, 3000, 1200);
    assert.strictEqual(deck.strategy, 'pad');
    assert.strictEqual(deck.anchorY, 0.2);
  });

  test('a deck document round-trips through serialize unchanged', () => {
    const deck = toDeckDocument(splitDocument({ source: SRC, n: 4, aspect: '1.91:1' }), 5000, 1400);
    assert.deepStrictEqual(parseDocument(serializeDocument(deck)), deck);
    assert.deepStrictEqual(normalizeDocument(deck), deck);
  });

  test('already deck, no slides, or no source dimensions: the mode flips, crops stay', () => {
    const split = splitDocument({ source: SRC, n: 2, aspect: '4:5' });
    for (const [w, h] of [
      [0, 0],
      [NaN, 800],
      [-10, 800],
    ]) {
      const deck = toDeckDocument(split, w, h);
      assert.strictEqual(deck.mode, 'deck');
      assert.deepStrictEqual(
        deck.slides.map((s) => s.crop),
        split.slides.map((s) => s.crop),
      );
    }
    // Idempotent: converting a deck document again is a no-op.
    const once = toDeckDocument(split, 4000, 1500);
    assert.deepStrictEqual(toDeckDocument(once, 4000, 1500), once);
    assert.deepStrictEqual(toDeckDocument({}, 4000, 1500).slides, []);
  });

  test("a pad deck's short tail slide is the only contain slide", () => {
    const [dstW, dstH] = canvasSize('4:5');
    // 3 columns' worth of width minus a bit: pad gives 3 slides, the last short.
    const srcW = 3 * dstW - 200;
    const split = splitDocument({ source: SRC, n: 3, aspect: '4:5', strategy: 'pad' });
    const deck = toDeckDocument(split, srcW, dstH + 400);
    assert.deepStrictEqual(
      deck.slides.map((s) => s.fit),
      ['cover', 'cover', 'contain'],
    );
    assert.strictEqual(Math.round(deck.slides[2].crop.w * srcW), dstW - 200);
  });

  // The acceptance test for the whole conversion: what the renderer draws after
  // it must be what the renderer drew before it.
  describe('renders the same pixels as the split document it came from', () => {
    const sources = [
      [4000, 1200],
      [3000, 3000],
      [1200, 4000],
      [5001, 1333],
      [2160, 1080],
      [7331, 997],
    ];
    const aspects = ['4:5', '1:1', '1.91:1'];
    const anchors = [0, 0.25, 0.5, 0.75, 1];

    /** Every slide of every deck the studio can build from these sources. */
    const sweep = (fn) => {
      for (const [srcW, srcH] of sources) {
        for (const aspect of aspects) {
          for (const strategy of ['cover', 'exact', 'pad']) {
            for (const anchorY of anchors) {
              for (const n of [2, 3, 5]) {
                const doc = splitDocument({ source: SRC, n, aspect, strategy, anchorY });
                const before = sliceRects(srcW, srcH, n, aspect, { strategy, anchorY });
                const after = toDeckDocument(doc, srcW, srcH).slides.map((s) =>
                  deckSlideRects(srcW, srcH, aspect, s.crop, s.fit),
                );
                const where = `${srcW}x${srcH} ${aspect} ${strategy} anchorY=${anchorY} n=${n}`;
                before.forEach((rect, i) =>
                  fn(rect, after[i], { where: `${where} slide ${i}`, aspect }),
                );
              }
            }
          }
        }
      }
    };

    test('the source region is the same, to within a rounded pixel an edge', () => {
      sweep((split, deck, { where }) => {
        // Never wider than what the split path was showing — the deck path can
        // only centre-crop further, never reveal source the user had not seen.
        assert.ok(deck.sx >= split.sx, `${where}: sx moved left`);
        assert.ok(deck.sx + deck.sw <= split.sx + split.sw, `${where}: right edge moved out`);
        assert.ok(deck.sy >= split.sy, `${where}: sy moved up`);
        assert.ok(deck.sy + deck.sh <= split.sy + split.sh, `${where}: bottom edge moved out`);
        assert.ok(deck.sx - split.sx <= 1, `${where}: sx off by ${deck.sx - split.sx}`);
        assert.ok(split.sw - deck.sw <= 2, `${where}: sw off by ${split.sw - deck.sw}`);
        assert.ok(deck.sy - split.sy <= 1, `${where}: sy off by ${deck.sy - split.sy}`);
        assert.ok(split.sh - deck.sh <= 2, `${where}: sh off by ${split.sh - deck.sh}`);
      });
    });

    test('the destination rect is identical — except a pad tail, which re-centres', () => {
      let tails = 0;
      sweep((split, deck, { where, aspect }) => {
        assert.strictEqual(deck.dy, split.dy, `${where}: dy`);
        assert.strictEqual(deck.dh, split.dh, `${where}: dh`);
        assert.strictEqual(deck.dw, split.dw, `${where}: dw`);
        if (!split.pad) {
          assert.strictEqual(deck.dx, split.dx, `${where}: dx`);
          assert.ok(!deck.pad, `${where}: a covered frame reports no pad`);
          return;
        }
        // The one visible difference. Split lays the short tail flush left and
        // fills the gap on the right; a contain slide is centred, so the same
        // total gap is split between the two sides.
        tails += 1;
        const [dstW] = canvasSize(aspect);
        assert.strictEqual(split.dx, 0, `${where}: the split tail is flush left`);
        assert.strictEqual(deck.dx, Math.round((dstW - deck.dw) / 2), `${where}: centred tail`);
        assert.ok(Array.isArray(deck.pad), `${where}: the gap is still reported as pad`);
        const gap = deck.pad.reduce((sum, p) => sum + p.w * p.h, 0);
        assert.strictEqual(gap, (dstW - split.dw) * split.dh, `${where}: same gap area`);
      });
      assert.ok(tails > 0, 'the sweep should cover at least one padded tail slide');
    });

    test('a feasible exact or pad deck converts pixel-for-pixel', () => {
      // Sized so neither strategy has to fall back to cover: tall enough for a
      // canvas, wide enough for the columns.
      for (const aspect of ['4:5', '1:1', '1.91:1']) {
        const [dstW, dstH] = canvasSize(aspect);
        for (const n of [2, 4]) {
          for (const strategy of ['exact', 'pad']) {
            const srcW = strategy === 'exact' ? n * dstW + 137 : (n - 1) * dstW + 400;
            const srcH = dstH + 311;
            for (const anchorY of [0, 0.5, 1]) {
              const doc = splitDocument({ source: SRC, n, aspect, strategy, anchorY });
              const before = sliceRects(srcW, srcH, n, aspect, { strategy, anchorY });
              const after = toDeckDocument(doc, srcW, srcH).slides.map((s) =>
                deckSlideRects(srcW, srcH, aspect, s.crop, s.fit),
              );
              before.forEach((rect, i) => {
                const where = `${aspect} ${strategy} n=${n} anchorY=${anchorY} slide ${i}`;
                assert.deepStrictEqual(
                  { sx: after[i].sx, sy: after[i].sy, sw: after[i].sw, sh: after[i].sh },
                  { sx: rect.sx, sy: rect.sy, sw: rect.sw, sh: rect.sh },
                  where,
                );
              });
            }
          }
        }
      }
    });
  });
});

describe('updateSlideFraming', () => {
  const deckDoc = () =>
    normalizeDocument({
      mode: 'deck',
      aspect: '4:5',
      slides: [
        { source: '/a.jpg', crop: { x: 0, y: 0, w: 0.5, h: 0.5 } },
        { source: '/b.jpg', crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
      ],
    });

  test('sets crop, fit and bg on the named slide only', () => {
    const doc = deckDoc();
    const next = updateSlideFraming(
      doc,
      1,
      { crop: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 }, fit: 'contain', bg: { type: 'solid', color: '#fff' } },
      { srcW: 2000, srcH: 1000 },
    );
    assert.deepStrictEqual(next.slides[1].crop, { x: 0.1, y: 0.2, w: 0.4, h: 0.4 });
    assert.strictEqual(next.slides[1].fit, 'contain');
    assert.deepStrictEqual(next.slides[1].bg, { type: 'solid', color: '#fff' });
    assert.deepStrictEqual(next.slides[0], doc.slides[0]);
  });

  test('a partial crop merges over the current one — a pan does not reset the zoom', () => {
    const next = updateSlideFraming(deckDoc(), 0, { crop: { x: 0.3 } }, { srcW: 2000, srcH: 1000 });
    assert.deepStrictEqual(next.slides[0].crop, { x: 0.3, y: 0, w: 0.5, h: 0.5 });
  });

  test('the crop is clamped through clampPan, using the source dimensions given', () => {
    const next = updateSlideFraming(
      deckDoc(),
      0,
      { crop: { x: 0.9, y: -1, w: 0.5, h: 4 } },
      { srcW: 2000, srcH: 1000 },
    );
    assert.deepStrictEqual(next.slides[0].crop, { x: 0.5, y: 0, w: 0.5, h: 1 });
    // No dimensions: still clamped to the normalized 0..1 box.
    const blind = updateSlideFraming(deckDoc(), 0, { crop: { x: 5, y: 5 } });
    assert.deepStrictEqual(blind.slides[0].crop, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  test('unknown keys and values the schema rejects are dropped', () => {
    const doc = deckDoc();
    const next = updateSlideFraming(
      doc,
      0,
      { fit: 'stretch', source: '/hijacked.jpg', layers: [{ t: 'x' }], nope: 1 },
      { srcW: 2000, srcH: 1000 },
    );
    assert.strictEqual(next.slides[0].fit, doc.slides[0].fit);
    assert.strictEqual(next.slides[0].source, '/a.jpg');
    assert.deepStrictEqual(next.slides[0].layers, []);
    assert.ok(!('nope' in next.slides[0]));
    // An explicit bg of garbage clears it, as normalizeBg does everywhere else.
    assert.strictEqual(updateSlideFraming(doc, 0, { bg: { type: 'plaid' } }).slides[0].bg, null);
    assert.strictEqual(updateSlideFraming(doc, 0, { bg: null }).slides[0].bg, null);
  });

  test('an out-of-range or nonsense slide index returns an equal document', () => {
    const doc = deckDoc();
    const same = serializeDocument(doc);
    for (const i of [-1, 2, 99, 1.5, NaN, undefined, null, 'one']) {
      assert.strictEqual(
        serializeDocument(updateSlideFraming(doc, i, { fit: 'contain' })),
        same,
        `index ${String(i)}`,
      );
    }
    assert.strictEqual(serializeDocument(updateSlideFraming(doc, 0, null)), same);
  });

  test('the input document is not mutated, and the result is already normal', () => {
    const doc = deckDoc();
    const before = serializeDocument(doc);
    const next = updateSlideFraming(doc, 0, { crop: { x: 0.4, y: 0.4 } }, { srcW: 100, srcH: 100 });
    assert.strictEqual(serializeDocument(doc), before);
    assert.deepStrictEqual(normalizeDocument(next), next);
    assert.deepStrictEqual(parseDocument(serializeDocument(next)), next);
  });

  test('one slide re-renders, the rest are reused: only its specHash changes', () => {
    const doc = normalizeDocument({
      mode: 'deck',
      aspect: '4:5',
      slides: Array.from({ length: 5 }, (_, i) => ({
        source: '/a.jpg',
        crop: { x: i / 5, y: 0, w: 0.2, h: 1 },
      })),
    });
    const hash = (d) => d.slides.map((s) => specHash(s, d.aspect, d));
    const before = hash(doc);
    const after = hash(updateSlideFraming(doc, 3, { crop: { y: 0.1, h: 0.8 } }, { srcW: 2000, srcH: 1000 }));
    after.forEach((h, i) => {
      if (i === 3) assert.notStrictEqual(h, before[i], 'slide 3 must miss');
      else assert.strictEqual(h, before[i], `slide ${i} must hit`);
    });
  });
});

describe('applyCarouselBlock', () => {
  const doc = {
    slides: [{ rendered: { path: '/2026/08/1.jpg' } }, { rendered: { path: '/2026/08/2.jpg' } }],
  };
  const block = ':::{.carousel-block}\n\n/2026/08/1.jpg\n\n/2026/08/2.jpg\n\n:::';

  test('appends the block to content that has none', () => {
    assert.strictEqual(
      applyCarouselBlock('Some intro copy.', doc),
      `Some intro copy.\n\n${block}`,
    );
  });

  test('empty content becomes just the block', () => {
    assert.strictEqual(applyCarouselBlock('', doc), block);
    assert.strictEqual(applyCarouselBlock(null, doc), block);
  });

  test('replaces an existing fence in place, leaving the rest untouched', () => {
    const before =
      'Intro.\n\n:::{.carousel-block}\n\n/2026/08/old-a.jpg\n\n/2026/08/old-b.jpg\n\n:::\n\nOutro.';
    assert.strictEqual(
      applyCarouselBlock(before, doc),
      `Intro.\n\n${block}\n\nOutro.`,
    );
  });

  test('a document with no rendered slides removes the fence', () => {
    const before = 'Intro.\n\n:::{.carousel-block}\n\n/2026/08/old.jpg\n\n:::\n\nOutro.';
    assert.strictEqual(
      applyCarouselBlock(before, { slides: [{ source: '/x' }] }),
      'Intro.\n\nOutro.',
    );
  });

  test('no fence and nothing to write is a no-op', () => {
    assert.strictEqual(applyCarouselBlock('Just text.', { slides: [] }), 'Just text.');
  });
});

describe('specHash', () => {
  const slide = {
    source: '/2026/08/a.jpg',
    crop: { x: 0, y: 0, w: 0.333, h: 1 },
    fit: 'cover',
    bg: { type: 'blur' },
    layers: [{ type: 'text', text: 'hi' }],
  };

  test('deterministic, 8 hex chars', () => {
    assert.match(specHash(slide), /^[0-9a-f]{8}$/);
    assert.strictEqual(specHash(slide), specHash(slide));
  });

  test('ignores the rendered block', () => {
    assert.strictEqual(
      specHash({ ...slide, rendered: { path: '/x', media_id: 1, specHash: 'old' } }),
      specHash({ ...slide, rendered: { path: '/y', media_id: 2, specHash: 'new' } }),
    );
  });

  test('key order does not matter', () => {
    assert.strictEqual(specHash({ source: '/a', fit: 'cover' }), specHash({ fit: 'cover', source: '/a' }));
  });

  test('changes when any pixel-affecting input changes', () => {
    const h = specHash(slide);
    assert.notStrictEqual(h, specHash({ ...slide, source: '/2026/08/b.jpg' }));
    assert.notStrictEqual(h, specHash({ ...slide, crop: { x: 0, y: 0, w: 0.5, h: 1 } }));
    assert.notStrictEqual(h, specHash({ ...slide, fit: 'contain' }));
    assert.notStrictEqual(h, specHash({ ...slide, bg: { type: 'solid' } }));
    assert.notStrictEqual(h, specHash({ ...slide, layers: [] }));
  });

  test('folds in the doc-level aspect when passed', () => {
    assert.notStrictEqual(specHash(slide, '4:5'), specHash(slide, '1:1'));
    assert.strictEqual(specHash(slide, '4:5'), specHash(slide, '4:5'));
  });

  test('folds in the doc-level strategy and anchorY — a change invalidates the render', () => {
    const base = specHash(slide, '4:5', { strategy: 'cover', anchorY: 0.5 });
    assert.notStrictEqual(base, specHash(slide, '4:5', { strategy: 'exact', anchorY: 0.5 }));
    assert.notStrictEqual(base, specHash(slide, '4:5', { strategy: 'pad', anchorY: 0.5 }));
    assert.notStrictEqual(base, specHash(slide, '4:5', { strategy: 'cover', anchorY: 0 }));
    assert.strictEqual(base, specHash(slide, '4:5', { strategy: 'cover', anchorY: 0.5 }));
  });
});
