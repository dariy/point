/**
 * carousel/studio/templates.js — the template gallery's arithmetic.
 *
 * The module is pure, so these tests are the whole contract: which strings in a
 * document are inlined assets, what replaces them, and why a template is
 * refused before it is sent. The uploading half lives in CarouselStudioPage's
 * tests, where there is a fake `upload` to fail on demand.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  dataAssets,
  decodeAsset,
  freeSlug,
  replaceAssets,
  templateLimitError,
  templateSlug,
} from '../src/plugins/carousel/studio/templates.js';
import { normalizeDocument, toTemplate } from '../src/plugins/carousel/document.js';

/** A tiny `data:` image URL — the shape an importer inlines. */
function inlined(bytes, mime = 'image/png') {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return `data:${mime};base64,${btoa(raw)}`;
}

const PNG = inlined([1, 2, 3, 4]);
const GIF = inlined([9, 9, 9], 'image/gif');

describe('carousel studio templates', () => {
  describe('templateSlug', () => {
    test('emits the character set the store accepts', () => {
      assert.strictEqual(templateSlug('Bold Quote Deck'), 'bold-quote-deck');
      assert.strictEqual(templateSlug('  Café  №2 '), 'caf-2');
    });

    test('never starts or ends with a separator, whatever the name did', () => {
      assert.strictEqual(templateSlug('--Hello--'), 'hello');
      assert.strictEqual(templateSlug('_under_'), 'under');
    });

    test('caps at the store\'s 100 characters, and trims what that cut', () => {
      const slug = templateSlug(`${'a'.repeat(99)} tail`);
      assert.strictEqual(slug.length, 99);
      assert.ok(!slug.endsWith('-'), 'no trailing separator after the cut');
    });

    test('falls back rather than emitting an empty slug', () => {
      assert.strictEqual(templateSlug('!!!'), 'template');
      assert.strictEqual(templateSlug(''), 'template');
      assert.strictEqual(templateSlug(null), 'template');
    });
  });

  describe('freeSlug', () => {
    test('leaves an unused slug alone', () => {
      assert.strictEqual(freeSlug('bold-quote', ['other']), 'bold-quote');
    });

    test('suffixes past the ones already taken — an import must not replace', () => {
      assert.strictEqual(freeSlug('deck', ['deck']), 'deck-2');
      assert.strictEqual(freeSlug('deck', ['deck', 'deck-2', 'deck-3']), 'deck-4');
    });
  });

  describe('dataAssets', () => {
    const doc = normalizeDocument({
      mode: 'deck',
      slides: [
        { source: PNG, layers: [{ type: 'image', source: GIF }] },
        { source: '/2026/09/photo.jpg', layers: [{ type: 'image', source: PNG }] },
      ],
      spanLayers: [{ type: 'image', source: inlined([7]) }],
    });

    test('finds inlined sources on slides, layers and span layers', () => {
      assert.deepStrictEqual(
        dataAssets(doc).map((a) => a.where),
        ['slide 1', 'slide 1, layer 1', 'deck layer 1'],
      );
    });

    test('deduplicates — a logo on eight slides is one upload', () => {
      const urls = dataAssets(doc).map((a) => a.url);
      assert.strictEqual(new Set(urls).size, urls.length);
      assert.strictEqual(urls.filter((u) => u === PNG).length, 1);
    });

    test('ignores content paths, which are already what the render wants', () => {
      assert.ok(!dataAssets(doc).some((a) => a.url.startsWith('/')));
    });

    test('answers empty for a document that has none', () => {
      assert.deepStrictEqual(dataAssets(normalizeDocument({})), []);
    });
  });

  describe('replaceAssets', () => {
    const doc = normalizeDocument({
      mode: 'deck',
      slides: [
        { source: PNG, layers: [{ type: 'image', source: GIF }] },
        { source: '/2026/09/kept.jpg', layers: [] },
      ],
      spanLayers: [{ type: 'image', source: PNG }],
    });

    test('swaps every occurrence of an inlined asset for its uploaded path', () => {
      const next = replaceAssets(
        doc,
        new Map([
          [PNG, '/2026/09/one.png'],
          [GIF, '/2026/09/two.gif'],
        ]),
      );
      assert.strictEqual(next.slides[0].source, '/2026/09/one.png');
      assert.strictEqual(next.slides[0].layers[0].source, '/2026/09/two.gif');
      assert.strictEqual(next.spanLayers[0].source, '/2026/09/one.png');
    });

    test('leaves content paths alone and does not mutate the input', () => {
      const next = replaceAssets(doc, new Map([[PNG, '/2026/09/one.png']]));
      assert.strictEqual(next.slides[1].source, '/2026/09/kept.jpg');
      assert.strictEqual(doc.slides[0].source, PNG, 'the original is untouched');
    });

    test('a url with no entry is left literal rather than blanked', () => {
      const next = replaceAssets(doc, new Map());
      assert.strictEqual(next.slides[0].source, PNG);
    });
  });

  describe('decodeAsset', () => {
    test('returns the bytes, the type, and a filename built from the stem', () => {
      const out = decodeAsset(PNG, 'carousel-template-42-1');
      assert.deepStrictEqual([...out.bytes], [1, 2, 3, 4]);
      assert.strictEqual(out.mime, 'image/png');
      assert.strictEqual(out.name, 'carousel-template-42-1.png');
    });

    test('refuses anything that is not a base64 image it can store', () => {
      assert.strictEqual(decodeAsset('/2026/09/photo.jpg', 'x'), null);
      assert.strictEqual(decodeAsset('data:text/plain;base64,aGk=', 'x'), null);
    });
  });

  describe('templateLimitError', () => {
    const envelope = (doc) => toTemplate(doc, { id: 'deck', name: 'Deck' });

    test('passes a template inside both caps', () => {
      assert.strictEqual(
        templateLimitError(envelope({ slides: [{ source: PNG }] })),
        '',
      );
    });

    test('names the slide whose image is over the per-image cap', () => {
      const out = templateLimitError(envelope({ slides: [{ source: PNG }] }), {
        maxAssetBytes: 2,
      });
      assert.match(out, /slide 1/);
      assert.match(out, /over the/);
    });

    test('names the whole template when the envelope is over the store\'s cap', () => {
      const out = templateLimitError(envelope({ slides: [{ source: PNG }] }), {
        maxTotalBytes: 40,
      });
      assert.match(out, /over the 0\.0 MB limit/);
      assert.match(out, /shrink some of its images/);
    });

    test('refuses an asset it could not decode at all, by place', () => {
      const out = templateLimitError({
        doc: { slides: [{ source: 'data:image/png;base64,!!!not base64!!!' }] },
      });
      assert.match(out, /slide 1/);
      assert.match(out, /not in a format Point can store/);
    });
  });
});
