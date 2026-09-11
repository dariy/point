/**
 * carousel/import/pptx.js — OOXML into a carousel template.
 *
 * The fixtures are hand-written OOXML packages built by
 * `fixtures/make-pptx.sh`, one per thing worth proving: a plain deck, a 16:9
 * one, one with images, one full of shapes the schema has no room for, and one
 * whose second slide is not XML at all. The XML is in the generator rather than
 * in opaque committed bytes, so what a test asserts on can be read.
 *
 * `DOMParser` comes from linkedom, because `node --test` has none. That is not
 * a stub: it parses the same bytes a browser would, and the two DOMs' known
 * disagreements — `localName` keeping its prefix, no `parsererror` document —
 * are exactly what `xml.js` is written around.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

import { normalizeDocument, applyTemplate } from '../src/plugins/carousel/document.js';
import { importPptx } from '../src/plugins/carousel/import/pptx.js';
import { ImportError, IMPORT_ACCEPT, IMPORTERS, adapterFor } from '../src/plugins/carousel/import/index.js';

globalThis.DOMParser = DOMParser;

const fixture = (name) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

/** The import, or a failure — `assert.rejects` needs the promise, not the value. */
const load = (name, options = {}) => importPptx(fixture(name), { filename: name, ...options });

const layersOf = (doc, i) => doc.slides[i].layers;
const dropped = (report) => report.dropped.map((d) => d.what);

describe('importPptx — a plain deck', () => {
  test('takes slide order from the id list, not from the filenames', async () => {
    const { template, report } = await load('deck-basic.pptx');
    // The parts are slide1, slide2, slide10 and the deck lists them in that
    // order; a filename sort would put slide10 second.
    assert.deepStrictEqual(
      template.doc.slides.map((s) => s.layers.find((l) => l.type === 'text').text),
      ['One', 'Two', 'Ten'],
    );
    assert.strictEqual(report.slides, 3);
    assert.strictEqual(report.sourceSlides, 3);
  });

  test('imports as a deck of independent slides, not a split panorama', async () => {
    const { template } = await load('deck-basic.pptx');
    assert.strictEqual(template.doc.mode, 'deck');
    assert.deepStrictEqual(template.doc.spanLayers, []);
  });

  test('keeps a canvas that already matches, and says the fit was exact', async () => {
    const { report } = await load('deck-basic.pptx');
    assert.strictEqual(report.aspect.from, '4:5');
    assert.strictEqual(report.aspect.to, '4:5');
    assert.strictEqual(report.aspect.margin, 0);
    assert.strictEqual(report.aspect.note, '4:5 matches 4:5');
  });

  test('maps a text box to a text layer, box, size and all', async () => {
    const { template } = await load('deck-basic.pptx');
    const text = layersOf(template.doc, 0).find((l) => l.type === 'text');
    assert.strictEqual(text.text, 'One');
    assert.strictEqual(text.weight, 700);
    assert.strictEqual(text.color, '#ffffff');
    assert.strictEqual(text.align, 'center');
    assert.strictEqual(text.valign, 'middle');
    assert.strictEqual(text.lineHeight, 0.9);
    // 40pt of a 1350px-tall slide, which is 1012.5pt: 3.95% of the height.
    assert.ok(Math.abs(text.size - 40 / 1012.5) < 1e-6, `size ${text.size}`);
    // 514350 EMU of 10287000 across, 9258300 wide.
    assert.ok(Math.abs(text.box.x - 0.05) < 1e-6, `x ${text.box.x}`);
    assert.ok(Math.abs(text.box.w - 0.9) < 1e-6, `w ${text.box.w}`);
  });

  test('maps a rounded, half-transparent band to a rect layer', async () => {
    const { template } = await load('deck-basic.pptx');
    const rect = layersOf(template.doc, 0).find((l) => l.type === 'rect');
    assert.strictEqual(rect.fill, '#112233');
    assert.strictEqual(rect.opacity, 0.8);
    // `adj` of 25000 is a quarter of the shorter side, which is what the
    // schema's `radius` already means.
    assert.strictEqual(rect.radius, 0.25);
  });

  test('paints back to front: the band was behind the headline and stays there', async () => {
    const { template } = await load('deck-basic.pptx');
    assert.deepStrictEqual(
      layersOf(template.doc, 0).map((l) => l.type),
      ['rect', 'text'],
    );
  });

  test('resolves a theme colour through the colour scheme', async () => {
    const { template } = await load('deck-basic.pptx');
    // Slide 2's run asks for `accent1`, which the fixture's theme sets.
    assert.strictEqual(layersOf(template.doc, 1)[0].color, '#ff5a5f');
  });

  test("falls back to the theme's body colour when a run states none", async () => {
    const { template } = await load('deck-basic.pptx');
    // Not the schema's white, which would be invisible on the light design
    // this deck's `dk1` implies.
    assert.strictEqual(layersOf(template.doc, 2)[0].color, '#1a1a1a');
  });

  test('records the fonts and applies none of them', async () => {
    const { template, report } = await load('deck-basic.pptx');
    assert.deepStrictEqual(template.origin.fonts, ['Poppins']);
    assert.deepStrictEqual(report.fonts, ['Poppins']);
    for (const slide of template.doc.slides) {
      for (const layer of slide.layers) assert.ok(!('font' in layer), 'no layer gained a font');
    }
    assert.match(report.warnings[0], /Type is set by the blog theme/);
  });

  test('records the source canvas in pixels', async () => {
    const { template } = await load('deck-basic.pptx');
    assert.deepStrictEqual(template.origin.srcSize, { w: 1080, h: 1350 });
    assert.strictEqual(template.origin.format, 'pptx');
    assert.strictEqual(template.origin.file, 'deck-basic.pptx');
  });

  test('names and slugs the template from the file', async () => {
    const { template } = await load('deck-basic.pptx', { filename: 'Bold  Quote Deck!.pptx' });
    assert.strictEqual(template.id, 'bold-quote-deck');
    assert.strictEqual(template.name, 'Bold  Quote Deck!');
    assert.strictEqual(template.templateVersion, 1);
  });

  test('every layer went through the schema: normalizing again changes nothing', async () => {
    const { template } = await load('deck-basic.pptx');
    assert.deepStrictEqual(normalizeDocument(template.doc), template.doc);
  });

  test('the envelope applies: a template with no placeholders round trips', async () => {
    const { template } = await load('deck-basic.pptx');
    const { doc, report } = applyTemplate(template);
    assert.deepStrictEqual(
      doc.slides.map((s) => s.layers),
      template.doc.slides.map((s) => s.layers),
    );
    assert.deepStrictEqual(report.unresolved, []);
    assert.strictEqual(doc.template.id, 'deck-basic');
  });

  test('placeholders are not guessed: the headline stays literal', async () => {
    const { template } = await load('deck-basic.pptx');
    const texts = template.doc.slides.flatMap((s) => s.layers.map((l) => l.text || ''));
    assert.ok(!texts.some((t) => /[{}]/.test(t)), texts.join('|'));
  });
});

describe('importPptx — the canvas fit', () => {
  test('16:9 lands in 1.91:1 with the margin named', async () => {
    const { template, report } = await load('deck-wide.pptx');
    assert.strictEqual(template.doc.aspect, '1.91:1');
    assert.strictEqual(report.aspect.from, '16:9');
    assert.strictEqual(report.aspect.axis, 'x');
    assert.strictEqual(report.aspect.note, '16:9 fitted into 1.91:1 — 3% margin each side');
    assert.ok(Math.abs(report.aspect.margin - 0.0342) < 0.001, `margin ${report.aspect.margin}`);
  });

  test('the fit is uniform: a shape keeps its proportions in canvas pixels', async () => {
    const { template } = await load('deck-wide.pptx');
    const box = layersOf(template.doc, 0).find((l) => l.type === 'text').box;
    // The source box is 10363200 x 2286000 EMU — 4.533:1. The 1.91:1 canvas is
    // 1080x566, so an unsquashed box has the same ratio there.
    const onCanvas = (box.w * 1080) / (box.h * 566);
    assert.ok(Math.abs(onCanvas - 10363200 / 2286000) < 0.01, `ratio ${onCanvas}`);
  });

  test('a full-frame gradient becomes the slide background, not a layer', async () => {
    const { template } = await load('deck-wide.pptx');
    assert.deepStrictEqual(template.doc.slides[0].bg, {
      type: 'gradient',
      // `ang` 5400000 is a quarter turn clockwise from the x-axis, which is
      // CSS's 180deg — top to bottom.
      angle: 180,
      stops: [
        { at: 0, color: '#101820' },
        { at: 1, color: '#486070' },
      ],
    });
    assert.ok(!layersOf(template.doc, 0).some((l) => l.type === 'rect'));
  });

  test('a forced aspect wins over the nearest one', async () => {
    const { template, report } = await load('deck-wide.pptx', { aspect: '1:1' });
    assert.strictEqual(template.doc.aspect, '1:1');
    assert.strictEqual(report.aspect.axis, 'y');
    assert.match(report.aspect.note, /^16:9 fitted into 1:1 — \d+% margin top and bottom$/);
  });
});

describe('importPptx — images', () => {
  test("a full-frame picture becomes the slide's own source, with its crop", async () => {
    const { template } = await load('deck-image.pptx');
    const slide = template.doc.slides[0];
    assert.match(slide.source, /^data:image\/png;base64,iVBOR/);
    assert.strictEqual(slide.fit, 'cover');
    // srcRect l=10% t=5% b=15% — the schema states the rectangle that survives.
    assert.ok(Math.abs(slide.crop.x - 0.1) < 1e-9);
    assert.ok(Math.abs(slide.crop.w - 0.9) < 1e-9);
    assert.ok(Math.abs(slide.crop.h - 0.8) < 1e-9);
  });

  test('a picture that does not cover the slide becomes an image layer', async () => {
    const { template } = await load('deck-image.pptx');
    const image = layersOf(template.doc, 0).find((l) => l.type === 'image');
    assert.match(image.source, /^data:image\/gif;base64,/);
    assert.strictEqual(image.fit, 'contain');
    assert.strictEqual(image.opacity, 0.6);
    assert.deepStrictEqual(image.box, { x: 0.8, y: 0.8, w: 0.1, h: 0.1 });
  });

  test('assets are counted by what the envelope costs', async () => {
    const { template, report } = await load('deck-image.pptx');
    const urls = [template.doc.slides[0].source, layersOf(template.doc, 0)[0].source];
    assert.strictEqual(report.assets.count, 2);
    assert.strictEqual(report.assets.bytes, urls[0].length + urls[1].length);
  });

  test('an image over the per-image cap is refused by name', async () => {
    const { template, report } = await load('deck-image.pptx', { maxAssetBytes: 32 });
    assert.strictEqual(template.doc.slides[0].source, '');
    assert.strictEqual(report.assets.count, 0);
    assert.ok(
      dropped(report).some((w) => /image1\.png .*per-image cap/.test(w)),
      dropped(report).join('|'),
    );
  });

  test('the whole-template budget is refused by name too', async () => {
    const { report } = await load('deck-image.pptx', { maxTotalBytes: 120 });
    assert.strictEqual(report.assets.count, 1);
    assert.ok(
      dropped(report).some((w) => /image budget is full/.test(w)),
      dropped(report).join('|'),
    );
  });

  test('a format no browser decodes is refused, not stored', async () => {
    const { report } = await load('deck-mixed.pptx');
    assert.ok(
      dropped(report).includes('image Point cannot store: logo.emf (unsupported format)'),
      dropped(report).join('|'),
    );
  });
});

describe('importPptx — drop and count', () => {
  test('names everything the schema had no room for', async () => {
    const { report } = await load('deck-mixed.pptx');
    for (const what of [
      'group (its shapes are not imported)',
      'chart',
      'table',
      'ellipse shape',
      'outline-only shape',
      'connector',
      'shape effect (shadow, glow or reflection)',
      'rotation (imported unrotated)',
      'italic or underlined type (imported plain)',
    ]) {
      assert.ok(dropped(report).includes(what), `${what} — got ${dropped(report).join('|')}`);
    }
    for (const entry of report.dropped) assert.strictEqual(entry.slide, 0);
  });

  test('says how much of the deck it kept', async () => {
    const { report } = await load('deck-mixed.pptx');
    // A text box and a rotated rectangle, out of eleven shapes.
    assert.deepStrictEqual(report.shapes, { kept: 2, total: 11 });
  });

  test('collapses identical drops into one counted entry', async () => {
    const { report } = await load('deck-mixed.pptx');
    const ellipses = report.dropped.filter((d) => d.what === 'ellipse shape');
    assert.strictEqual(ellipses.length, 1);
    assert.strictEqual(ellipses[0].n, 2);
  });

  test('a rotated shape is imported, unrotated, rather than dropped', async () => {
    const { template } = await load('deck-mixed.pptx');
    const rect = layersOf(template.doc, 0).find((l) => l.type === 'rect');
    assert.strictEqual(rect.fill, '#00a699');
    assert.ok(!('rot' in rect.box), 'the schema has no rotation and none was invented');
  });

  test('placeholder inheritance is counted, never guessed at', async () => {
    const { template, report } = await load('deck-mixed.pptx');
    assert.ok(dropped(report).includes('text whose geometry comes from the slide layout'));
    const texts = layersOf(template.doc, 0).filter((l) => l.type === 'text');
    assert.deepStrictEqual(
      texts.map((l) => l.text),
      ['Kept'],
    );
  });

  test('the report the studio shows survives storage in the envelope', async () => {
    const { template, report } = await load('deck-mixed.pptx');
    assert.deepStrictEqual(template.origin.dropped, report.dropped);
    // And the import does not pad the deck to make it applyable: this is a
    // one-slide file, and `applyTemplate` is the thing that pads, on the way in.
    assert.strictEqual(template.doc.slides.length, 1);
    assert.deepStrictEqual(applyTemplate(template).report.clampedSlides, { from: 1, to: 2 });
  });

  test('a slide background gradient is read from the theme colours it names', async () => {
    const { template } = await load('deck-mixed.pptx');
    assert.strictEqual(template.doc.slides[0].bg.type, 'gradient');
    assert.deepStrictEqual(template.doc.slides[0].bg.stops[0], { at: 0, color: '#eeeeee' });
    // `ang` 0 runs left to right, which is 90deg in CSS.
    assert.strictEqual(template.doc.slides[0].bg.angle, 90);
  });
});

describe('importPptx — failures', () => {
  test('one unreadable slide costs that slide, not the import', async () => {
    const { template, report } = await load('deck-broken.pptx');
    assert.strictEqual(template.doc.slides.length, 2);
    assert.strictEqual(report.slides, 2);
    assert.strictEqual(report.sourceSlides, 3);
    assert.deepStrictEqual(
      template.doc.slides.map((s) => s.layers[0].text),
      ['First', 'Third'],
    );
    assert.strictEqual(report.failed.length, 1);
    assert.strictEqual(report.failed[0].slide, 1);
    assert.strictEqual(report.failed[0].part, 'ppt/slides/slide2.xml');
    assert.match(report.failed[0].reason, /not readable as a slide/);
  });

  test('a file that is not an archive at all', async () => {
    await assert.rejects(importPptx(new Uint8Array(64), { filename: 'photo.jpg' }), (err) => {
      assert.ok(err instanceof ImportError);
      assert.strictEqual(err.code, 'malformed');
      assert.match(err.message, /not a readable \.pptx/);
      return true;
    });
  });

  test('an archive that names a slide it does not contain', async () => {
    // `zip-shape.pptx` is the ZIP reader's fixture: a real archiver's output,
    // with a `presentation.xml` that lists one slide and no `_rels` to resolve
    // it through. Nothing to import, and the reason is stated.
    await assert.rejects(load('zip-shape.pptx'), (err) => {
      assert.strictEqual(err.code, 'malformed');
      assert.match(err.message, /names no slide this file contains/);
      return true;
    });
  });

  test('an archive with an empty slide list', async () => {
    await assert.rejects(load('deck-empty.pptx'), (err) => {
      assert.strictEqual(err.code, 'empty');
      assert.match(err.message, /contains no slides/);
      return true;
    });
  });

  test('a runtime with no DOMParser says so', async () => {
    const saved = globalThis.DOMParser;
    delete globalThis.DOMParser;
    try {
      await assert.rejects(load('deck-basic.pptx'), (err) => {
        assert.strictEqual(err.code, 'unsupported');
        assert.match(err.message, /no DOMParser/);
        return true;
      });
    } finally {
      globalThis.DOMParser = saved;
    }
  });

  test('the parser is a seam, so a caller can supply its own', async () => {
    const saved = globalThis.DOMParser;
    delete globalThis.DOMParser;
    try {
      const { template } = await load('deck-basic.pptx', { parser: DOMParser });
      assert.strictEqual(template.doc.slides.length, 3);
    } finally {
      globalThis.DOMParser = saved;
    }
  });
});

describe('the import registry', () => {
  test('finds the adapter by extension, whatever the case', () => {
    const adapter = adapterFor('Deck.PPTX');
    assert.strictEqual(adapter && adapter.format, 'pptx');
    assert.strictEqual(adapter.read, importPptx);
    assert.strictEqual(adapter.takesList, false);
  });

  test('has nothing for a format it does not read', () => {
    assert.strictEqual(adapterFor('deck.key'), null);
    assert.strictEqual(adapterFor(''), null);
    assert.strictEqual(adapterFor(undefined), null);
  });

  test('offers a file-input accept value covering every adapter', () => {
    for (const adapter of IMPORTERS) assert.ok(IMPORT_ACCEPT.includes(adapter.accept));
    assert.ok(IMPORT_ACCEPT.includes('.pptx'));
  });
});
