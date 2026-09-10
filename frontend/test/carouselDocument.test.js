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
  addSlide,
  duplicateSlide,
  emptyDocument,
  moveSlide,
  removeSlide,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  buildCarouselBlock,
  applyCarouselBlock,
  splitDocument,
  toDeckDocument,
  updateSlideFraming,
  specHash,
  normalizeLayer,
  addLayer,
  updateLayer,
  removeLayer,
  reorderLayer,
  LAYER_TYPES,
  SPAN_SLIDE,
} from '../src/plugins/carousel/document.js';
import {
  canvasSize,
  sliceRects,
  deckSlideRects,
  spanLayerCoverage,
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

  /** `bg` is what the render paints around a contained slide, so an unusable
   *  value has to degrade here — `addColorStop` throws mid-encode otherwise. */
  describe('bg fill', () => {
    const bgOf = (bg) => normalizeDocument({ slides: [{ bg }] }).slides[0].bg;

    test('solid defaults to black and rejects a colour canvas could not parse', () => {
      assert.deepStrictEqual(bgOf({ type: 'solid' }), { type: 'solid', color: '#000000' });
      assert.deepStrictEqual(bgOf({ type: 'solid', color: 'rebeccapurple' }), {
        type: 'solid',
        color: '#000000',
      });
      assert.deepStrictEqual(bgOf({ type: 'solid', color: ' #AABBCC ' }), {
        type: 'solid',
        color: '#aabbcc',
      });
      assert.deepStrictEqual(bgOf({ type: 'solid', color: 'transparent' }), {
        type: 'solid',
        color: 'transparent',
      });
    });

    test('blur keeps a positive radius and drops anything else', () => {
      assert.deepStrictEqual(bgOf({ type: 'blur', radius: 40 }), { type: 'blur', radius: 40 });
      assert.deepStrictEqual(bgOf({ type: 'blur', radius: 0 }), { type: 'blur' });
      assert.deepStrictEqual(bgOf({ type: 'blur', radius: -8 }), { type: 'blur' });
      assert.deepStrictEqual(bgOf({ type: 'blur', radius: 'wide' }), { type: 'blur' });
    });

    test('gradient fills in the angle and stops it was not given', () => {
      const bg = bgOf({ type: 'gradient' });
      assert.strictEqual(bg.angle, 180, 'top → bottom');
      assert.strictEqual(bg.stops.length, 2, 'a gradient needs two stops to be one');
      assert.deepStrictEqual(
        bg.stops.map((s) => s.at),
        [0, 1],
      );
    });

    test('gradient angles wrap into 0..360 and stops clamp into 0..1', () => {
      const stops = [
        { at: -1, color: '#000' },
        { at: 9, color: '#fff' },
      ];
      assert.deepStrictEqual(bgOf({ type: 'gradient', angle: 450, stops }), {
        type: 'gradient',
        angle: 90,
        stops: [
          { at: 0, color: '#000' },
          { at: 1, color: '#fff' },
        ],
      });
      assert.strictEqual(bgOf({ type: 'gradient', angle: -90, stops }).angle, 270);
      assert.strictEqual(bgOf({ type: 'gradient', angle: 'sideways', stops }).angle, 180);
    });

    test('gradient stops with no `at` are spread evenly across the line', () => {
      const bg = bgOf({
        type: 'gradient',
        stops: [{ color: '#000000' }, { color: '#808080' }, { color: '#ffffff' }],
      });
      assert.deepStrictEqual(
        bg.stops.map((s) => s.at),
        [0, 0.5, 1],
      );
    });

    test('a gradient the canvas could not paint degrades to the default', () => {
      const fallback = bgOf({ type: 'gradient' }).stops;
      // Unparseable colours are dropped; fewer than two left is not a gradient.
      for (const stops of [
        undefined,
        'red to blue',
        [],
        [{ color: '#000000' }],
        [{ color: 'octarine' }, { color: 'ultraviolet' }],
        [{ color: '#000000' }, { at: 1 }],
      ]) {
        assert.deepStrictEqual(
          bgOf({ type: 'gradient', stops }).stops,
          fallback,
          `stops: ${JSON.stringify(stops)}`,
        );
      }
    });

    test('a normalized bg is idempotent, for every type', () => {
      for (const bg of [
        { type: 'blur', radius: 30 },
        { type: 'solid', color: '#123456' },
        { type: 'gradient', angle: 45, stops: [{ at: 0.2, color: '#fff' }, { at: 0.9, color: '#000' }] },
      ]) {
        const once = bgOf(bg);
        assert.deepStrictEqual(bgOf(once), once, bg.type);
      }
    });
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

  test('carries span layers through unchanged — a re-slice re-flows the headline, not drops it', () => {
    const span = [
      { type: 'text', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 }, text: 'Across the seam' },
    ];
    const four = splitDocument({ source: '/x.jpg', n: 4, aspect: '4:5', spanLayers: span });
    assert.strictEqual(four.spanLayers.length, 1);
    assert.strictEqual(four.spanLayers[0].text, 'Across the seam');
    // The studio passes the current document's span layers back in on every
    // re-slice; a smaller count keeps them (the box is deck-normalized).
    const two = splitDocument({ source: '/x.jpg', n: 2, aspect: '4:5', spanLayers: four.spanLayers });
    assert.deepStrictEqual(two.spanLayers, four.spanLayers);
  });

  test('no span layers is an empty list, not undefined', () => {
    assert.deepStrictEqual(
      splitDocument({ source: '/x.jpg', n: 3, aspect: '4:5' }).spanLayers,
      [],
    );
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

describe('layer schema', () => {
  /** The layers of a one-slide document, normalized. */
  const layersOf = (layers) => normalizeDocument({ slides: [{ layers }] }).slides[0].layers;
  /** One normalized layer, or null. */
  const one = (layer) => layersOf([layer])[0] ?? null;
  const FULL_BOX = { x: 0, y: 0, w: 1, h: 1 };

  test('every type normalizes to its full shape, from nothing but a type', () => {
    assert.deepStrictEqual(one({ type: 'text' }), {
      type: 'text',
      box: FULL_BOX,
      text: '',
      lineHeight: 1.2,
      align: 'left',
      valign: 'top',
      color: '#ffffff',
      weight: 400,
      size: null,
      shadow: false,
    });
    assert.deepStrictEqual(one({ type: 'image' }), {
      type: 'image',
      box: FULL_BOX,
      source: '',
      fit: 'contain',
      opacity: 1,
    });
    assert.deepStrictEqual(one({ type: 'rect' }), {
      type: 'rect',
      box: FULL_BOX,
      fill: '#000000',
      opacity: 1,
      radius: 0,
    });
    assert.deepStrictEqual(one({ type: 'counter' }), {
      type: 'counter',
      box: FULL_BOX,
      format: '{i}/{n}',
      align: 'left',
      valign: 'top',
      color: '#ffffff',
      weight: 400,
      size: null,
      shadow: false,
    });
    assert.deepStrictEqual(one({ type: 'arrow' }), {
      type: 'arrow',
      box: FULL_BOX,
      direction: 'right',
      color: '#ffffff',
      opacity: 1,
    });
  });

  test('every type round-trips through parse(serialize(doc))', () => {
    const doc = {
      slides: [
        {
          source: '/2026/08/a.jpg',
          layers: [
            { type: 'text', box: { x: 0.08, y: 0.62, w: 0.84, h: 0.3 }, text: 'Hello', align: 'center', valign: 'bottom', color: '#ff0000', weight: 700, size: 0.09, lineHeight: 1.4, shadow: true },
            { type: 'image', box: { x: 0.7, y: 0.05, w: 0.25, h: 0.1 }, source: '/2026/08/logo.png', fit: 'cover', opacity: 0.8 },
            { type: 'rect', box: { x: 0, y: 0.8, w: 1, h: 0.2 }, fill: '#00000080', opacity: 0.5, radius: 0.25 },
            { type: 'counter', box: { x: 0.85, y: 0.02, w: 0.13, h: 0.06 }, format: 'Slide {i} of {n}', align: 'right', color: 'transparent' },
            { type: 'arrow', box: { x: 0.9, y: 0.45, w: 0.08, h: 0.1 }, direction: 'left', color: '#fff', opacity: 0.6 },
          ],
        },
      ],
      spanLayers: [{ type: 'text', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 }, text: 'Across the seam' }],
    };
    const normal = normalizeDocument(doc);
    assert.strictEqual(normal.slides[0].layers.length, 5);
    assert.strictEqual(normal.spanLayers.length, 1);
    assert.deepStrictEqual(parseDocument(serializeDocument(doc)), normal);
  });

  test('an unrecognized type is dropped, and so is anything that is not a layer', () => {
    // The one place the schema loses user data — deliberate: a layer's fields
    // mean nothing without its type, so there is nothing to migrate.
    assert.deepStrictEqual(layersOf([{ type: 'video' }, { type: '' }, {}]), []);
    assert.deepStrictEqual(layersOf(['text', null, undefined, 42, [], [{ type: 'rect' }]]), []);
    assert.deepStrictEqual(layersOf('rect'), []);
    assert.deepStrictEqual(layersOf(undefined), []);
    assert.strictEqual(normalizeLayer({ type: 'video' }), null);
  });

  test('the survivors keep their order; the casualties do not leave a hole', () => {
    const kept = layersOf([{ type: 'rect' }, null, { type: 'nope' }, { type: 'arrow' }]);
    assert.deepStrictEqual(
      kept.map((l) => l.type),
      ['rect', 'arrow'],
    );
  });

  test('unknown fields are dropped, as everywhere in this module', () => {
    assert.deepStrictEqual(Object.keys(one({ type: 'rect', bogus: 1, text: 'no' })).sort(), [
      'box',
      'fill',
      'opacity',
      'radius',
      'type',
    ]);
  });

  test('a box is clamped to 0..1 and pushed back inside the canvas', () => {
    assert.deepStrictEqual(one({ type: 'rect', box: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }).box, {
      x: 0.5,
      y: 0.5,
      w: 0.5,
      h: 0.5,
    });
    assert.deepStrictEqual(one({ type: 'rect', box: { x: -1, y: 2, w: 0, h: 99 } }).box, {
      x: 0,
      y: 0,
      w: 1 / 1080, // one canvas pixel: below that a layer cannot be seen or grabbed
      h: 1,
    });
    assert.deepStrictEqual(one({ type: 'rect', box: 'nope' }).box, FULL_BOX);
    assert.deepStrictEqual(one({ type: 'rect', box: { w: 0.4 } }).box, { x: 0, y: 0, w: 0.4, h: 1 });
  });

  test('a span layer box clamps against the same 0..1 range', () => {
    // A span box means "the whole deck" rather than "one slide" — the
    // renderer's business; the schema clamps it to the same 0..1 either way.
    const doc = normalizeDocument({ spanLayers: [{ type: 'text', box: { x: 0.8, y: 0, w: 0.75, h: 1 } }] });
    assert.deepStrictEqual(doc.spanLayers[0].box, { x: 0.25, y: 0, w: 0.75, h: 1 });
  });

  test('colours go through the one hex validator normalizeBg already uses', () => {
    assert.strictEqual(one({ type: 'text', color: '#ABC' }).color, '#abc');
    assert.strictEqual(one({ type: 'text', color: '  #11223344 ' }).color, '#11223344');
    assert.strictEqual(one({ type: 'text', color: 'transparent' }).color, 'transparent');
    assert.strictEqual(one({ type: 'text', color: 'rebeccapurple' }).color, '#ffffff');
    assert.strictEqual(one({ type: 'rect', fill: '#123456' }).fill, '#123456');
    assert.strictEqual(one({ type: 'rect', fill: 'octarine' }).fill, '#000000');
  });

  test('numbers are clamped, not rejected', () => {
    assert.strictEqual(one({ type: 'text', weight: 5000 }).weight, 1000);
    assert.strictEqual(one({ type: 'text', weight: -3 }).weight, 1);
    assert.strictEqual(one({ type: 'text', weight: 612.4 }).weight, 612);
    assert.strictEqual(one({ type: 'text', weight: 'bold' }).weight, 400);
    assert.strictEqual(one({ type: 'text', lineHeight: 0.1 }).lineHeight, 0.5);
    assert.strictEqual(one({ type: 'text', lineHeight: 99 }).lineHeight, 4);
    assert.strictEqual(one({ type: 'text', lineHeight: 'x' }).lineHeight, 1.2);
    assert.strictEqual(one({ type: 'rect', opacity: 2 }).opacity, 1);
    assert.strictEqual(one({ type: 'rect', opacity: -1 }).opacity, 0);
    assert.strictEqual(one({ type: 'rect', opacity: 'half' }).opacity, 1);
    assert.strictEqual(one({ type: 'rect', radius: 3 }).radius, 0.5);
    assert.strictEqual(one({ type: 'rect', radius: -1 }).radius, 0);
  });

  test('size is null for auto-fit, a fraction of the canvas otherwise', () => {
    assert.strictEqual(one({ type: 'text', size: null }).size, null);
    assert.strictEqual(one({ type: 'text', size: 'big' }).size, null);
    assert.strictEqual(one({ type: 'text', size: 0.07 }).size, 0.07);
    assert.strictEqual(one({ type: 'text', size: 4 }).size, 1);
    assert.strictEqual(one({ type: 'text', size: 0 }).size, 1 / 1080);
  });

  test('the remaining enums and coercions', () => {
    assert.strictEqual(one({ type: 'text', align: 'center' }).align, 'center');
    assert.strictEqual(one({ type: 'text', align: 'justify' }).align, 'left');
    assert.strictEqual(one({ type: 'text', valign: 'middle' }).valign, 'middle');
    assert.strictEqual(one({ type: 'text', valign: 'baseline' }).valign, 'top');
    assert.strictEqual(one({ type: 'text', text: 42 }).text, '');
    assert.strictEqual(one({ type: 'text', shadow: 1 }).shadow, true);
    assert.strictEqual(one({ type: 'text', shadow: 0 }).shadow, false);
    assert.strictEqual(one({ type: 'image', fit: 'cover' }).fit, 'cover');
    assert.strictEqual(one({ type: 'image', fit: 'stretch' }).fit, 'contain');
    assert.strictEqual(one({ type: 'image', source: 8 }).source, '');
    assert.strictEqual(one({ type: 'counter', format: 'Slide {i}' }).format, 'Slide {i}');
    assert.strictEqual(one({ type: 'counter', format: 42 }).format, '{i}/{n}');
    assert.strictEqual(one({ type: 'arrow', direction: 'left' }).direction, 'left');
    assert.strictEqual(one({ type: 'arrow', direction: 'up' }).direction, 'right');
  });

  test('normalizeDocument stays idempotent over a document full of layers', () => {
    // The property the bare `.slice()` passthrough was silently failing.
    const doc = {
      mode: 'deck',
      slides: [
        { source: '/a.jpg', layers: [{ type: 'text', text: 'hi', weight: 5000, box: { x: 0.9, w: 0.5 } }] },
        { source: '/b.jpg', layers: LAYER_TYPES.map((type) => ({ type })) },
      ],
      spanLayers: [{ type: 'arrow', direction: 'left' }, { type: 'video' }],
    };
    const once = normalizeDocument(doc);
    assert.deepStrictEqual(normalizeDocument(once), once);
    assert.strictEqual(serializeDocument(once), serializeDocument(normalizeDocument(once)));
    for (const layer of [...once.slides[0].layers, ...once.slides[1].layers, ...once.spanLayers]) {
      assert.deepStrictEqual(normalizeLayer(layer), layer, layer.type);
    }
  });
});

describe('layer mutators', () => {
  const docOf = (...layers) =>
    normalizeDocument({
      mode: 'deck',
      slides: [{ source: '/a.jpg', layers }, { source: '/b.jpg' }],
    });
  const text = { type: 'text', text: 'one', box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
  const rect = { type: 'rect', fill: '#112233' };
  const arrow = { type: 'arrow', direction: 'left' };

  test('addLayer appends — the list paints back to front', () => {
    const doc = addLayer(addLayer(docOf(), 0, text), 0, rect);
    assert.deepStrictEqual(
      doc.slides[0].layers.map((l) => l.type),
      ['text', 'rect'],
    );
    assert.strictEqual(doc.slides[0].layers[0].text, 'one');
    assert.strictEqual(doc.slides[1].layers.length, 0, 'other slides untouched');
  });

  test('addLayer normalizes on the way in, and rejects what cannot be a layer', () => {
    assert.strictEqual(addLayer(docOf(), 0, { type: 'text', weight: 5000 }).slides[0].layers[0].weight, 1000);
    const doc = docOf();
    for (const bad of [{ type: 'video' }, null, 'text', 42]) {
      assert.strictEqual(serializeDocument(addLayer(doc, 0, bad)), serializeDocument(doc), String(bad));
    }
  });

  test('updateLayer merges a patch, and box merges field by field', () => {
    const doc = updateLayer(docOf(text), 0, 0, { text: 'two', box: { x: 0.4 } });
    assert.strictEqual(doc.slides[0].layers[0].text, 'two');
    assert.deepStrictEqual(doc.slides[0].layers[0].box, { x: 0.4, y: 0.1, w: 0.5, h: 0.5 });
  });

  test('a patch value the schema rejects leaves the layer its own', () => {
    // updateSlideFraming's contract, kept field for field: a rejected value is
    // not a reset to the default.
    const doc = docOf({ ...text, align: 'center', color: '#ff0000', size: 0.2 });
    const next = updateLayer(doc, 0, 0, { align: 'sideways', color: 'rebeccapurple', size: 'big' });
    const layer = next.slides[0].layers[0];
    assert.strictEqual(layer.align, 'center');
    assert.strictEqual(layer.color, '#ff0000');
    assert.strictEqual(layer.size, 0.2);
  });

  test('updateLayer cannot change a type, and drops unknown keys', () => {
    const next = updateLayer(docOf(text), 0, 0, { type: 'image', source: '/logo.png', bogus: 1 });
    assert.deepStrictEqual(Object.keys(next.slides[0].layers[0]).sort(), [
      'align',
      'box',
      'color',
      'lineHeight',
      'shadow',
      'size',
      'text',
      'type',
      'valign',
      'weight',
    ]);
    assert.strictEqual(next.slides[0].layers[0].type, 'text');
  });

  test('removeLayer drops exactly one, keeping the order of the rest', () => {
    const doc = removeLayer(docOf(text, rect, arrow), 0, 1);
    assert.deepStrictEqual(
      doc.slides[0].layers.map((l) => l.type),
      ['text', 'arrow'],
    );
  });

  test('reorderLayer shifts the rest — it is not a swap', () => {
    const doc = docOf(text, rect, arrow);
    const types = (d) => d.slides[0].layers.map((l) => l.type);
    assert.deepStrictEqual(types(reorderLayer(doc, 0, 0, 2)), ['rect', 'arrow', 'text']);
    assert.deepStrictEqual(types(reorderLayer(doc, 0, 2, 0)), ['arrow', 'text', 'rect']);
    assert.deepStrictEqual(types(reorderLayer(doc, 0, 1, 1)), ['text', 'rect', 'arrow']);
  });

  test('a slideIndex of -1 addresses doc.spanLayers, through the same four calls', () => {
    let doc = addLayer(addLayer(docOf(), SPAN_SLIDE, text), SPAN_SLIDE, rect);
    assert.strictEqual(SPAN_SLIDE, -1);
    assert.deepStrictEqual(
      doc.spanLayers.map((l) => l.type),
      ['text', 'rect'],
    );
    assert.strictEqual(doc.slides[0].layers.length, 0, 'span layers are not a slide');

    doc = updateLayer(doc, SPAN_SLIDE, 0, { text: 'across' });
    assert.strictEqual(doc.spanLayers[0].text, 'across');

    doc = reorderLayer(doc, SPAN_SLIDE, 1, 0);
    assert.deepStrictEqual(
      doc.spanLayers.map((l) => l.type),
      ['rect', 'text'],
    );

    doc = removeLayer(doc, SPAN_SLIDE, 0);
    assert.deepStrictEqual(
      doc.spanLayers.map((l) => l.type),
      ['text'],
    );
  });

  test('an out-of-range index returns an equal document rather than throwing', () => {
    const doc = docOf(text);
    const same = serializeDocument(doc);
    const cases = [
      () => addLayer(doc, 9, rect),
      () => addLayer(doc, -2, rect),
      () => addLayer(doc, null, rect),
      () => addLayer(doc, 0.5, rect),
      () => updateLayer(doc, 0, 3, { text: 'x' }),
      () => updateLayer(doc, 9, 0, { text: 'x' }),
      () => updateLayer(doc, SPAN_SLIDE, 0, { text: 'x' }),
      () => updateLayer(doc, 0, 0, null),
      () => removeLayer(doc, 0, 7),
      () => removeLayer(doc, -3, 0),
      () => reorderLayer(doc, 0, 0, 4),
      () => reorderLayer(doc, 0, -1, 0),
      () => reorderLayer(doc, 9, 0, 0),
    ];
    cases.forEach((run, i) => assert.strictEqual(serializeDocument(run()), same, `case ${String(i)}`));
  });

  test('every mutator is pure, and returns an already-normal document', () => {
    const doc = docOf(text, rect);
    const before = serializeDocument(doc);
    for (const next of [
      addLayer(doc, 0, arrow),
      updateLayer(doc, 0, 0, { text: 'edited' }),
      removeLayer(doc, 0, 0),
      reorderLayer(doc, 0, 0, 1),
      addLayer(doc, SPAN_SLIDE, rect),
    ]) {
      assert.strictEqual(serializeDocument(doc), before, 'input not mutated');
      assert.deepStrictEqual(normalizeDocument(next), next);
      assert.deepStrictEqual(parseDocument(serializeDocument(next)), next);
    }
  });

  test('a layer edit re-renders exactly the slide it touched', () => {
    const doc = docOf(text);
    const hash = (d) => d.slides.map((s) => specHash(s, d.aspect, d));
    const before = hash(doc);
    const after = hash(updateLayer(doc, 0, 0, { text: 'changed' }));
    assert.notStrictEqual(after[0], before[0], 'slide 0 must miss');
    assert.strictEqual(after[1], before[1], 'slide 1 must hit');
  });
});

describe('slide mutators', () => {
  const layer = { type: 'text', text: 'one', box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
  const span = { type: 'text', text: 'across', box: { x: 0.06, y: 0.1, w: 0.88, h: 0.2 } };

  /** A three-slide deck, each slide identifiable by its source. */
  const deck = () =>
    normalizeDocument({
      mode: 'deck',
      slides: [
        { source: '/a.jpg', crop: { x: 0, y: 0, w: 0.3, h: 1 }, layers: [layer] },
        { source: '/b.jpg', rendered: { path: '/r2.jpg', media_id: 2, specHash: 'abc' } },
        { source: '/c.jpg', fit: 'contain' },
      ],
      spanLayers: [span],
    });

  const sources = (doc) => doc.slides.map((s) => s.source);

  test('addSlide inserts at a position, and slides.length appends', () => {
    assert.deepStrictEqual(sources(addSlide(deck(), 1)), ['/a.jpg', '/a.jpg', '/b.jpg', '/c.jpg']);
    assert.deepStrictEqual(sources(addSlide(deck(), 0)), ['/a.jpg', '/a.jpg', '/b.jpg', '/c.jpg']);
    assert.deepStrictEqual(sources(addSlide(deck(), 3)), ['/a.jpg', '/b.jpg', '/c.jpg', '/c.jpg']);
  });

  test('a slide added with nothing given shows its neighbour\'s photo, uncropped', () => {
    const added = addSlide(deck(), 1).slides[1];
    assert.strictEqual(added.source, '/a.jpg', "the slide it follows, so it is not blank");
    assert.deepStrictEqual(added.crop, { x: 0, y: 0, w: 1, h: 1 });
    assert.strictEqual(added.fit, 'cover');
    assert.deepStrictEqual(added.layers, [], 'its own slide, not a copy of one');
    assert.strictEqual(added.rendered, null);
  });

  test('at the head the new slide takes the photo of the slide it precedes', () => {
    assert.strictEqual(addSlide(deck(), 0).slides[0].source, '/a.jpg');
  });

  test('an explicit slide is normalized on the way in, and never arrives rendered', () => {
    const doc = addSlide(deck(), 0, {
      source: '/new.jpg',
      fit: 'nonsense',
      crop: { w: 5 },
      layers: [layer, { type: 'video' }],
      rendered: { path: '/stolen.jpg', media_id: 2, specHash: 'abc' },
    });
    assert.strictEqual(doc.slides[0].source, '/new.jpg');
    assert.strictEqual(doc.slides[0].fit, 'cover', 'a rejected value falls back to the schema default');
    assert.deepStrictEqual(doc.slides[0].crop, { x: 0, y: 0, w: 1, h: 1 });
    assert.strictEqual(doc.slides[0].layers.length, 1, 'the unrecognized layer is dropped');
    assert.strictEqual(
      doc.slides[0].rendered,
      null,
      'two slides must never claim one media row — the supersede cleanup cannot unpick it',
    );
  });

  test('removeSlide drops exactly one, keeping the order of the rest', () => {
    assert.deepStrictEqual(sources(removeSlide(deck(), 1)), ['/a.jpg', '/c.jpg']);
    assert.deepStrictEqual(sources(removeSlide(deck(), 0)), ['/b.jpg', '/c.jpg']);
    assert.deepStrictEqual(sources(removeSlide(deck(), 2)), ['/a.jpg', '/b.jpg']);
  });

  test('removeSlide takes the rendered block with it — the media row is the caller\'s to delete', () => {
    const doc = removeSlide(deck(), 1);
    assert.ok(!doc.slides.some((s) => s.rendered), 'no slide still points at the removed render');
  });

  test('duplicateSlide lands a copy directly after its twin, layers and framing included', () => {
    const doc = duplicateSlide(deck(), 0);
    assert.deepStrictEqual(sources(doc), ['/a.jpg', '/a.jpg', '/b.jpg', '/c.jpg']);
    assert.deepStrictEqual(doc.slides[1].crop, doc.slides[0].crop);
    assert.deepStrictEqual(doc.slides[1].layers, doc.slides[0].layers);
    assert.strictEqual(doc.slides[1].fit, doc.slides[0].fit);
  });

  test('a duplicate is unrendered, however rendered its twin was', () => {
    const doc = duplicateSlide(deck(), 1);
    assert.ok(doc.slides[1].rendered, 'the original keeps its render');
    assert.strictEqual(doc.slides[2].rendered, null, 'the copy has none to keep');
  });

  test('a duplicate is a separate slide — editing one leaves the other alone', () => {
    const doc = updateSlideFraming(duplicateSlide(deck(), 0), 1, { fit: 'contain' });
    assert.strictEqual(doc.slides[0].fit, 'cover');
    assert.strictEqual(doc.slides[1].fit, 'contain');
  });

  test('moveSlide shifts the rest — it is not a swap', () => {
    assert.deepStrictEqual(sources(moveSlide(deck(), 0, 2)), ['/b.jpg', '/c.jpg', '/a.jpg']);
    assert.deepStrictEqual(sources(moveSlide(deck(), 2, 0)), ['/c.jpg', '/a.jpg', '/b.jpg']);
    assert.deepStrictEqual(sources(moveSlide(deck(), 1, 2)), ['/a.jpg', '/c.jpg', '/b.jpg']);
  });

  test('a moved slide carries its own layers and its render with it', () => {
    const doc = moveSlide(deck(), 1, 0);
    assert.strictEqual(doc.slides[0].rendered.media_id, 2);
    assert.strictEqual(doc.slides[1].layers[0].text, 'one');
  });

  test('an out-of-range index returns an equal document rather than throwing', () => {
    const doc = deck();
    const same = serializeDocument(doc);
    const cases = [
      () => addSlide(doc, 4),
      () => addSlide(doc, -1),
      () => addSlide(doc, null),
      () => addSlide(doc, 1.5),
      () => removeSlide(doc, 3),
      () => removeSlide(doc, -1),
      () => removeSlide(doc, null),
      () => duplicateSlide(doc, 3),
      () => duplicateSlide(doc, -1),
      () => moveSlide(doc, 0, 3),
      () => moveSlide(doc, -1, 0),
      () => moveSlide(doc, 0, 0),
      () => moveSlide(doc, 9, 9),
    ];
    cases.forEach((run, i) => assert.strictEqual(serializeDocument(run()), same, `case ${String(i)}`));
  });

  test('every mutator is pure, and returns an already-normal document', () => {
    const doc = deck();
    const before = serializeDocument(doc);
    for (const next of [
      addSlide(doc, 1),
      removeSlide(doc, 1),
      duplicateSlide(doc, 0),
      moveSlide(doc, 0, 2),
    ]) {
      assert.strictEqual(serializeDocument(doc), before, 'input not mutated');
      assert.deepStrictEqual(normalizeDocument(next), next);
      assert.deepStrictEqual(parseDocument(serializeDocument(next)), next);
    }
  });

  test('a numeric string names a slide, as it does throughout the module', () => {
    // `layerIndexIn` and `updateSlideFraming` both coerce; these four agree
    // with them rather than inventing a second answer for the same input.
    assert.strictEqual(
      serializeDocument(addSlide(deck(), '1')),
      serializeDocument(addSlide(deck(), 1)),
    );
  });

  test('a changed slide count re-flows the span layers rather than dropping them', () => {
    // A span box is a fraction of the whole n-wide deck, so the layer itself
    // does not move — the seams move under it, which is what `splitDocument`
    // already relies on when it re-slices. `spanLayerCoverage` is where that
    // shows: the same headline now crosses a different set of slides.
    const doc = deck();
    const added = addSlide(doc, 1);
    assert.deepStrictEqual(added.spanLayers, doc.spanLayers, 'the layer is untouched');
    assert.deepStrictEqual(
      spanLayerCoverage(doc.spanLayers[0], doc.slides.length, doc.aspect),
      [0, 1, 2],
    );
    assert.deepStrictEqual(
      spanLayerCoverage(added.spanLayers[0], added.slides.length, added.aspect),
      [0, 1, 2, 3],
      'four seams instead of three, same layer',
    );
  });

  test('changing the slide count re-renders every slide — the span layers moved under them', () => {
    const doc = deck();
    const hash = (d) => d.slides.map((s) => specHash(s, d.aspect, d));
    const before = hash(doc);
    const after = hash(removeSlide(doc, 2));
    // `specHash` folds in the doc-level spanLayers, and the layers themselves
    // are unchanged — so this is a *hit*, and the survivors reuse their render
    // even though the seams beneath the span layer moved. The renderer redraws
    // the span from the new count regardless; see `slideSpecHash` in index.js.
    assert.deepStrictEqual(after, before.slice(0, 2));
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

  test('a background edit re-encodes exactly the slide it touched', () => {
    // The fill is part of the pixels, so every field of it has to move the hash
    // — otherwise the C8 dedup would keep a slide rendered with the old fill.
    const solid = { ...slide, bg: { type: 'solid', color: '#112233' } };
    const gradient = {
      ...slide,
      bg: { type: 'gradient', angle: 180, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }] },
    };
    const hashes = [
      specHash(slide),
      specHash(solid),
      specHash({ ...solid, bg: { ...solid.bg, color: '#332211' } }),
      specHash(gradient),
      specHash({ ...gradient, bg: { ...gradient.bg, angle: 90 } }),
      specHash({
        ...gradient,
        bg: { ...gradient.bg, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#cccccc' }] },
      }),
    ];
    assert.strictEqual(new Set(hashes).size, hashes.length, `distinct: ${hashes.join()}`);
    // And a fill that only *looks* different does not: `#FFF` is `#fff`.
    assert.strictEqual(
      specHash({ ...slide, bg: { type: 'solid', color: '#FFF' } }),
      specHash({ ...slide, bg: { type: 'solid', color: '#fff' } }),
    );
  });

  test('folds in the doc-level aspect when passed', () => {
    assert.notStrictEqual(specHash(slide, '4:5'), specHash(slide, '1:1'));
    assert.strictEqual(specHash(slide, '4:5'), specHash(slide, '4:5'));
  });

  test('folds in the doc-level spanLayers — they paint across a slide that cannot see them', () => {
    const deck = { strategy: 'cover', anchorY: 0.5 };
    const base = specHash(slide, '4:5', deck);
    const span = (...spanLayers) => specHash(slide, '4:5', { ...deck, spanLayers });
    assert.strictEqual(base, span(), 'no span layers is the document that had none');
    assert.notStrictEqual(base, span({ type: 'rect', fill: '#123456' }));
    assert.notStrictEqual(
      span({ type: 'rect', fill: '#123456' }),
      span({ type: 'rect', fill: '#654321' }),
      'editing one must invalidate the render',
    );
    assert.notStrictEqual(
      span({ type: 'rect' }, { type: 'arrow' }),
      span({ type: 'arrow' }, { type: 'rect' }),
      'paint order is part of the pixels',
    );
    // A span layer the schema drops cannot change anything either.
    assert.strictEqual(base, span({ type: 'video' }));
  });

  test('folds in the doc-level strategy and anchorY — a change invalidates the render', () => {
    const base = specHash(slide, '4:5', { strategy: 'cover', anchorY: 0.5 });
    assert.notStrictEqual(base, specHash(slide, '4:5', { strategy: 'exact', anchorY: 0.5 }));
    assert.notStrictEqual(base, specHash(slide, '4:5', { strategy: 'pad', anchorY: 0.5 }));
    assert.notStrictEqual(base, specHash(slide, '4:5', { strategy: 'cover', anchorY: 0 }));
    assert.strictEqual(base, specHash(slide, '4:5', { strategy: 'cover', anchorY: 0.5 }));
  });
});
