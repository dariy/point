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
  specHash,
} from '../src/plugins/carousel/document.js';

describe('normalizeDocument', () => {
  test('an empty input becomes the default document', () => {
    assert.deepStrictEqual(normalizeDocument({}), {
      version: DOC_VERSION,
      aspect: '4:5',
      mode: 'split',
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
});
