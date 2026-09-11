/**
 * carousel/import/svg.js — SVG into a carousel template.
 *
 * The fixtures are written here as source rather than committed as files: an
 * SVG *is* its text, so a test that asserts on a fill can be read beside the
 * fill it asserts on. Each one is shaped the way a real exporter writes —
 * Illustrator's `.cls-1` stylesheet, Figma's `<g transform>`, Canva's outlined
 * headlines — because those are the four files this importer will actually be
 * handed.
 *
 * `DOMParser` comes from linkedom, because `node --test` has none. It parses
 * `image/svg+xml` the same way a browser does, and the disagreements that do
 * exist are what `xml.js` is written around.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { DOMParser } from 'linkedom';

import { normalizeDocument, applyTemplate } from '../src/plugins/carousel/document.js';
import { importSvg, naturalOrder } from '../src/plugins/carousel/import/svg.js';
import {
  ImportError,
  IMPORT_ACCEPT,
  IMPORTERS,
  adapterFor,
} from '../src/plugins/carousel/import/index.js';

globalThis.DOMParser = DOMParser;

/** A 1x1 PNG and a 1x1 GIF, the two smallest real images there are. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** An SVG file, as the importer takes one. */
const file = (name, body, attrs = 'viewBox="0 0 1080 1350"') => ({
  name,
  text: `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`,
});

/** A slide from one of Canva's square templates: a band, and a headline on it. */
const headline = (name, words) =>
  file(
    name,
    `<rect x="54" y="945" width="972" height="270" rx="27" fill="#112233" fill-opacity="0.8"/>
     <text x="540" y="1080" font-family="Poppins, sans-serif" font-size="72"
           font-weight="bold" fill="#ffffff" text-anchor="middle">${words}</text>`,
  );

const load = (files, options = {}) => importSvg(files, options);
const layersOf = (doc, i) => doc.slides[i].layers;
const dropped = (report) => report.dropped.map((d) => d.what);
const typed = (doc, i, type) => layersOf(doc, i).find((l) => l.type === type);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('importSvg — a deck of files', () => {
  const deck = [
    headline('slide-10.svg', 'Ten'),
    headline('slide-1.svg', 'One'),
    headline('slide-2.svg', 'Two'),
  ];

  test('orders the slides by a natural filename sort, not the order handed over', async () => {
    const { template, report } = await load(deck);
    assert.deepStrictEqual(
      template.doc.slides.map((s) => s.layers.find((l) => l.type === 'text').text),
      ['One', 'Two', 'Ten'],
    );
    assert.strictEqual(report.slides, 3);
    assert.strictEqual(report.sourceSlides, 3);
  });

  test('states the order it chose, so a wrong guess is visible', async () => {
    const { report } = await load(deck);
    assert.deepStrictEqual(report.order, ['slide-1.svg', 'slide-2.svg', 'slide-10.svg']);
    assert.ok(
      report.warnings.some((w) => /Slide order came from the filenames: slide-1\.svg/.test(w)),
      report.warnings.join('|'),
    );
  });

  test('one file is one slide, in a deck of independent slides', async () => {
    const { template } = await load(deck);
    assert.strictEqual(template.doc.mode, 'deck');
    assert.deepStrictEqual(template.doc.spanLayers, []);
    assert.strictEqual(template.doc.slides.length, 3);
  });

  test('says nothing about order when there is only one file', async () => {
    const { report } = await load([headline('one.svg', 'One')]);
    assert.deepStrictEqual(report.order, ['one.svg']);
    assert.ok(!report.warnings.some((w) => /Slide order/.test(w)), report.warnings.join('|'));
  });

  test('names the deck from what the files have in common', async () => {
    const { template, report } = await load(deck);
    assert.strictEqual(template.id, 'slide');
    assert.strictEqual(report.file, '3 SVG files');
    assert.strictEqual(template.origin.format, 'svg');
  });

  test('a single file names itself, and a caller can override either way', async () => {
    const one = await load([headline('Bold Quote.svg', 'One')]);
    assert.strictEqual(one.template.id, 'bold-quote');
    assert.strictEqual(one.template.name, 'Bold Quote');
    const named = await load(deck, { filename: 'Winter Series.svg' });
    assert.strictEqual(named.template.id, 'winter-series');
    assert.strictEqual(named.report.file, 'Winter Series.svg');
  });

  test('keeps a canvas that already matches, and says the fit was exact', async () => {
    const { template, report } = await load(deck);
    assert.strictEqual(template.doc.aspect, '4:5');
    assert.strictEqual(report.aspect.note, '4:5 matches 4:5');
    assert.deepStrictEqual(template.origin.srcSize, { w: 1080, h: 1350 });
  });

  test('maps a rounded, half-transparent band to a rect layer', async () => {
    const { template } = await load(deck);
    const rect = typed(template.doc, 0, 'rect');
    assert.strictEqual(rect.fill, '#112233');
    assert.strictEqual(rect.opacity, 0.8);
    // 27 of the 270-unit shorter side, which is what the schema's radius means.
    assert.strictEqual(rect.radius, 0.1);
    assert.ok(near(rect.box.x, 0.05) && near(rect.box.y, 0.7), JSON.stringify(rect.box));
    assert.ok(near(rect.box.w, 0.9) && near(rect.box.h, 0.2), JSON.stringify(rect.box));
  });

  test('paints back to front: the band was behind the headline and stays there', async () => {
    const { template } = await load(deck);
    assert.deepStrictEqual(
      layersOf(template.doc, 0).map((l) => l.type),
      ['rect', 'text'],
    );
  });

  test('records the fonts and applies none of them', async () => {
    const { template, report } = await load(deck);
    // `sans-serif` names no typeface and is not recorded as one.
    assert.deepStrictEqual(template.origin.fonts, ['Poppins']);
    assert.deepStrictEqual(report.fonts, ['Poppins']);
    for (const slide of template.doc.slides) {
      for (const layer of slide.layers) assert.ok(!('font' in layer), 'no layer gained a font');
    }
    assert.ok(report.warnings.some((w) => /Type is set by the blog theme/.test(w)));
  });

  test('every layer went through the schema: normalizing again changes nothing', async () => {
    const { template } = await load(deck);
    assert.deepStrictEqual(normalizeDocument(template.doc), template.doc);
  });

  test('the envelope applies: a template with no placeholders round trips', async () => {
    const { template } = await load(deck);
    const { doc, report } = applyTemplate(template);
    assert.deepStrictEqual(
      doc.slides.map((s) => s.layers),
      template.doc.slides.map((s) => s.layers),
    );
    assert.deepStrictEqual(report.unresolved, []);
    assert.strictEqual(doc.template.id, 'slide');
  });

  test('placeholders are not guessed: the headline stays literal', async () => {
    const { template } = await load(deck);
    const texts = template.doc.slides.flatMap((s) => s.layers.map((l) => l.text || ''));
    assert.ok(!texts.some((t) => /[{}]/.test(t)), texts.join('|'));
  });
});

describe('importSvg — text', () => {
  test('anchors the box where the file anchored the words', async () => {
    const { template } = await load([headline('a.svg', 'One')]);
    const text = typed(template.doc, 0, 'text');
    assert.strictEqual(text.text, 'One');
    assert.strictEqual(text.align, 'center');
    assert.strictEqual(text.valign, 'top');
    assert.strictEqual(text.weight, 700);
    assert.strictEqual(text.color, '#ffffff');
    // 72 units of a 1350-unit canvas.
    assert.ok(near(text.size, 72 / 1350), `size ${text.size}`);
    // Anchored at the middle of the canvas, so the widest centred box is all of it.
    assert.ok(near(text.box.x, 0) && near(text.box.w, 1), JSON.stringify(text.box));
    // One line, so the box starts a half line box and an em-middle above the
    // baseline the file drew from.
    assert.ok(near(text.box.y, (1080 - (0.35 + 0.6) * 72) / 1350), `y ${text.box.y}`);
    assert.ok(near(text.box.h, (1.2 * 72) / 1350), `h ${text.box.h}`);
  });

  test('a left-anchored line gets the width from its anchor to the edge', async () => {
    const { template } = await load([
      file('a.svg', '<text x="108" y="200" font-size="40">Left</text>'),
    ]);
    const text = typed(template.doc, 0, 'text');
    assert.strictEqual(text.align, 'left');
    assert.ok(near(text.box.x, 0.1) && near(text.box.w, 0.9), JSON.stringify(text.box));
  });

  test('a right-anchored one gets the width up to it', async () => {
    const { template } = await load([
      file('a.svg', '<text x="972" y="200" font-size="40" text-anchor="end">Right</text>'),
    ]);
    const text = typed(template.doc, 0, 'text');
    assert.strictEqual(text.align, 'right');
    assert.ok(near(text.box.x, 0) && near(text.box.w, 0.9), JSON.stringify(text.box));
  });

  test('tspans that start a line become lines, and their dy becomes the spacing', async () => {
    const { template } = await load([
      file(
        'a.svg',
        `<text x="80" y="200" font-size="40" fill="rgb(255, 90, 95)">
           <tspan x="80">First line</tspan>
           <tspan x="80" dy="48">Second line</tspan>
         </text>`,
      ),
    ]);
    const text = typed(template.doc, 0, 'text');
    assert.strictEqual(text.text, 'First line\nSecond line');
    assert.strictEqual(text.lineHeight, 1.2);
    assert.strictEqual(text.color, '#ff5a5f');
    assert.ok(near(text.box.h, (2 * 1.2 * 40) / 1350), `h ${text.box.h}`);
  });

  test('a dy in em is the multiple it already is', async () => {
    const { template } = await load([
      file(
        'a.svg',
        `<text x="80" y="200" font-size="40">
           <tspan x="80">A</tspan><tspan x="80" dy="1.5em">B</tspan>
         </text>`,
      ),
    ]);
    assert.strictEqual(typed(template.doc, 0, 'text').lineHeight, 1.5);
  });

  test('markup whitespace is not part of the headline', async () => {
    const { template } = await load([
      file('a.svg', '<text x="80" y="200" font-size="40">\n      Spaced   out\n    </text>'),
    ]);
    assert.strictEqual(typed(template.doc, 0, 'text').text, 'Spaced out');
  });

  test('an opacity on type folds into the colour, which is where the schema keeps it', async () => {
    const { template } = await load([
      file('a.svg', '<text x="80" y="200" font-size="40" fill="#ffffff" opacity="0.5">Dim</text>'),
    ]);
    assert.strictEqual(typed(template.doc, 0, 'text').color, '#ffffff80');
  });

  test('type with no colour is black, as SVG draws it — not the schema white', async () => {
    const { template } = await load([file('a.svg', '<text x="80" y="200">Plain</text>')]);
    const text = typed(template.doc, 0, 'text');
    assert.strictEqual(text.color, '#000000');
    // The CSS initial font size, since the file states none.
    assert.ok(near(text.size, 16 / 1350), `size ${text.size}`);
  });

  test('an empty text element is counted, not kept', async () => {
    const { template, report } = await load([file('a.svg', '<text x="10" y="10"> </text>')]);
    assert.deepStrictEqual(layersOf(template.doc, 0), []);
    assert.ok(dropped(report).includes('text with no words in it'), dropped(report).join('|'));
  });
});

describe('importSvg — style resolution', () => {
  const styled = file(
    'styled.svg',
    `<style>
       .cls-1 { fill: #00a699; }
       text { font-size: 24px; text-anchor: middle; }
       #big { font-size: 60px; }
       @media print { .cls-1 { fill: #000000; } }
       .a > .b { fill: #ff0000; }
     </style>
     <rect class="cls-1" fill="#ff0000" x="0" y="0" width="540" height="675"/>
     <text id="big" class="cls-1" x="540" y="200" style="fill:#123456">Styled</text>
     <g fill="#ffffff"><rect x="0" y="1000" width="100" height="100"/></g>`,
  );

  test('a stylesheet beats a presentation attribute, as CSS says it does', async () => {
    const { template } = await load([styled]);
    assert.strictEqual(layersOf(template.doc, 0)[0].fill, '#00a699');
  });

  test('a style attribute beats the stylesheet, and an id beats a tag', async () => {
    const { template } = await load([styled]);
    const text = typed(template.doc, 0, 'text');
    assert.strictEqual(text.color, '#123456');
    assert.ok(near(text.size, 60 / 1350), `size ${text.size}`);
    assert.strictEqual(text.align, 'center');
  });

  test('fill inherits from the group that states it', async () => {
    const { template } = await load([styled]);
    // The band, the headline, then the rectangle inside the white group.
    assert.deepStrictEqual(
      layersOf(template.doc, 0).map((l) => l.type),
      ['rect', 'text', 'rect'],
    );
    assert.strictEqual(layersOf(template.doc, 0)[2].fill, '#ffffff');
  });

  test('CSS beyond the handful of properties is counted, not interpreted', async () => {
    const { report } = await load([styled]);
    const what = dropped(report).join('|');
    assert.ok(dropped(report).includes('CSS at-rule Point does not read'), what);
    assert.ok(dropped(report).includes('CSS selector Point does not read'));
  });

  test('a hidden layer is dropped by name rather than imported invisibly', async () => {
    const { template, report } = await load([
      file('a.svg', '<rect x="0" y="0" width="10" height="10" fill="#fff" display="none"/>'),
    ]);
    assert.deepStrictEqual(layersOf(template.doc, 0), []);
    assert.ok(dropped(report).includes('hidden element'));
  });

  test('a colour Point cannot read is named, not guessed at', async () => {
    const { report } = await load([
      file(
        'a.svg',
        `<rect x="0" y="0" width="10" height="10" fill="url(#grad)"/>
         <rect x="0" y="0" width="10" height="10" fill="none"/>
         <rect x="0" y="0" width="10" height="10" fill="rebeccapurple"/>`,
      ),
    ]);
    for (const what of [
      'gradient or pattern fill',
      'shape with no fill',
      'shape with a colour Point could not read: rebeccapurple',
    ]) {
      assert.ok(dropped(report).includes(what), `${what} — got ${dropped(report).join('|')}`);
    }
  });
});

describe('importSvg — transforms', () => {
  test('a translate and a scale flatten into the box exactly', async () => {
    const { template, report } = await load([
      file(
        'a.svg',
        `<g transform="translate(108,135) scale(2)">
           <rect x="54" y="54" width="108" height="270" fill="#ffffff"/>
         </g>`,
      ),
    ]);
    const rect = typed(template.doc, 0, 'rect');
    assert.ok(near(rect.box.x, (108 + 108) / 1080), `x ${rect.box.x}`);
    assert.ok(near(rect.box.y, (135 + 108) / 1350), `y ${rect.box.y}`);
    assert.ok(
      near(rect.box.w, 216 / 1080) && near(rect.box.h, 540 / 1350),
      JSON.stringify(rect.box),
    );
    assert.deepStrictEqual(dropped(report), []);
  });

  test('a rotation is imported square and named, not dropped', async () => {
    const { template, report } = await load([
      file(
        'a.svg',
        '<rect x="100" y="100" width="200" height="100" fill="#00a699" transform="rotate(30)"/>',
      ),
    ]);
    assert.strictEqual(typed(template.doc, 0, 'rect').fill, '#00a699');
    assert.ok(
      dropped(report).includes('rotation or skew (imported square)'),
      dropped(report).join('|'),
    );
  });

  test('an effect on the group it was applied to is reported there', async () => {
    // How Figma writes a drop shadow: on the `<g>`, not on the card inside it.
    const { template, report } = await load([
      file(
        'a.svg',
        `<g filter="url(#shadow)" clip-path="url(#round)">
           <rect x="100" y="100" width="200" height="100" fill="#ffffff"/>
         </g>`,
      ),
    ]);
    assert.strictEqual(typed(template.doc, 0, 'rect').fill, '#ffffff');
    assert.ok(dropped(report).includes('filter (blur, shadow or glow)'), dropped(report).join('|'));
    assert.ok(dropped(report).includes('clip path (imported uncropped)'));
  });

  test('a mirrored shape says so', async () => {
    const { report } = await load([
      file(
        'a.svg',
        '<rect x="10" y="10" width="20" height="20" fill="#fff" transform="scale(-1,1)"/>',
      ),
    ]);
    assert.ok(dropped(report).includes('flip (imported unflipped)'), dropped(report).join('|'));
  });

  test('a matrix scales the type it carries', async () => {
    const { template } = await load([
      file(
        'a.svg',
        '<text transform="matrix(2 0 0 2 100 200)" x="0" y="0" font-size="30">Big</text>',
      ),
    ]);
    const text = typed(template.doc, 0, 'text');
    assert.ok(near(text.size, 60 / 1350), `size ${text.size}`);
  });
});

describe('importSvg — images', () => {
  const withImages = file(
    'shot.svg',
    `<image x="0" y="0" width="1080" height="1350" href="${PNG}"
            preserveAspectRatio="xMidYMid slice"/>
     <image x="864" y="1080" width="108" height="135" href="${GIF}" opacity="0.6"/>
     <image x="0" y="0" width="100" height="100" href="https://example.com/logo.png"/>`,
  );

  test("a full-frame image becomes the slide's own source", async () => {
    const { template } = await load([withImages]);
    const slide = template.doc.slides[0];
    assert.match(slide.source, /^data:image\/png;base64,iVBOR/);
    assert.strictEqual(slide.fit, 'cover');
  });

  test('one that does not cover the canvas becomes an image layer', async () => {
    const { template } = await load([withImages]);
    const image = typed(template.doc, 0, 'image');
    assert.match(image.source, /^data:image\/gif;base64,/);
    assert.strictEqual(image.fit, 'contain');
    assert.strictEqual(image.opacity, 0.6);
    assert.deepStrictEqual(image.box, { x: 0.8, y: 0.8, w: 0.1, h: 0.1 });
  });

  test('an image on someone else’s server is refused, not fetched', async () => {
    const { report } = await load([withImages]);
    assert.ok(dropped(report).includes('image stored outside the file'), dropped(report).join('|'));
  });

  test('assets are counted by what the envelope costs', async () => {
    const { template, report } = await load([withImages]);
    const urls = [template.doc.slides[0].source, typed(template.doc, 0, 'image').source];
    assert.strictEqual(report.assets.count, 2);
    assert.strictEqual(report.assets.bytes, urls[0].length + urls[1].length);
  });

  test('the same image twice costs the budget once', async () => {
    const { report } = await load([
      file(
        'a.svg',
        `<image x="0" y="0" width="50" height="50" href="${GIF}"/>
         <image x="60" y="0" width="50" height="50" href="${GIF}"/>`,
      ),
    ]);
    assert.strictEqual(report.assets.count, 1);
  });

  test('an image over the per-image cap is refused by name', async () => {
    const { template, report } = await load([withImages], { maxAssetBytes: 16 });
    assert.strictEqual(template.doc.slides[0].source, '');
    assert.strictEqual(report.assets.count, 0);
    assert.ok(
      dropped(report).some((w) => /image-1\.png .*per-image cap/.test(w)),
      dropped(report).join('|'),
    );
  });

  test('the whole-template budget is refused by name too', async () => {
    // The PNG is 118 encoded bytes and the GIF 78: room for the first only.
    const { report } = await load([withImages], { maxTotalBytes: 150 });
    assert.strictEqual(report.assets.count, 1);
    assert.ok(
      dropped(report).some((w) => /image budget is full/.test(w)),
      dropped(report).join('|'),
    );
  });

  test('a format no browser decodes is refused, not stored', async () => {
    const { report } = await load([
      file(
        'a.svg',
        '<image x="0" y="0" width="50" height="50" href="data:image/x-emf;base64,QUJD"/>',
      ),
    ]);
    assert.ok(
      dropped(report).some((w) => /format it cannot decode/.test(w)),
      dropped(report).join('|'),
    );
  });
});

describe('importSvg — the outlined-text warning', () => {
  const outlined = (n) =>
    file(
      'canva-export.svg',
      Array.from({ length: n }, (_, i) => `<path d="M${i} 0 L10 10 Z" fill="#000"/>`).join(''),
    );

  test('a slide of paths and no text is called what it is', async () => {
    const { report } = await load([outlined(42)]);
    assert.ok(
      report.warnings.some(
        (w) =>
          /canva-export\.svg has no text and 42 vector paths/.test(w) &&
          /re-export with outlining off/.test(w),
      ),
      report.warnings.join('|'),
    );
  });

  test('a few paths beside a headline are art, and say nothing', async () => {
    const { report } = await load([
      file(
        'a.svg',
        `<text x="80" y="200" font-size="40">Kept</text>
         ${Array.from({ length: 6 }, () => '<path d="M0 0 L1 1 Z"/>').join('')}`,
      ),
    ]);
    assert.ok(!report.warnings.some((w) => /outlin/.test(w)), report.warnings.join('|'));
  });

  test('paths beside a headline are not the warning either, however many', async () => {
    const { report } = await load([
      file(
        'a.svg',
        `<text x="80" y="200" font-size="40">Kept</text>
         ${Array.from({ length: 30 }, () => '<path d="M0 0 L1 1 Z"/>').join('')}`,
      ),
    ]);
    assert.ok(!report.warnings.some((w) => /outlin/.test(w)), report.warnings.join('|'));
  });

  test('the paths themselves are counted, one entry with a count', async () => {
    const { report } = await load([outlined(42)]);
    const paths = report.dropped.filter((d) => d.what === 'path (a vector outline)');
    assert.strictEqual(paths.length, 1);
    assert.strictEqual(paths[0].n, 42);
    assert.deepStrictEqual(report.shapes, { kept: 0, total: 42 });
  });
});

describe('importSvg — drop and count', () => {
  const mixed = file(
    'mixed.svg',
    `<defs><clipPath id="c"><rect x="0" y="0" width="10" height="10"/></clipPath></defs>
     <text x="80" y="200" font-size="40" clip-path="url(#c)">Kept</text>
     <circle cx="10" cy="10" r="5"/>
     <ellipse cx="10" cy="10" rx="5" ry="3"/>
     <polygon points="0,0 10,0 5,10"/>
     <polyline points="0,0 10,10"/>
     <line x1="0" y1="0" x2="10" y2="10"/>
     <use href="#c"/>
     <foreignObject width="10" height="10"><div>hi</div></foreignObject>
     <script>alert(1)</script>
     <rect x="0" y="0" width="10" height="10" fill="#fff" filter="url(#f)" mask="url(#m)"/>`,
  );

  test('names everything the schema had no room for', async () => {
    const { report } = await load([mixed]);
    for (const what of [
      'circle',
      'ellipse',
      'polygon',
      'polyline',
      'line',
      'use (a copy of a defined shape)',
      'embedded HTML',
      'script (never imported)',
      'filter (blur, shadow or glow)',
      'clip path (imported uncropped)',
      'mask (imported unmasked)',
    ]) {
      assert.ok(dropped(report).includes(what), `${what} — got ${dropped(report).join('|')}`);
    }
    for (const entry of report.dropped) assert.strictEqual(entry.slide, 0);
  });

  test('says how much of the file it kept', async () => {
    const { report } = await load([mixed]);
    // The headline and the filtered rectangle, out of nine painted elements —
    // the script is not a shape and the `<defs>` paints nothing.
    assert.deepStrictEqual(report.shapes, { kept: 2, total: 9 });
  });

  test('a definition nobody references costs nothing and is not reported', async () => {
    const { report } = await load([mixed]);
    assert.ok(!dropped(report).some((w) => /clipPath|<defs>/.test(w)), dropped(report).join('|'));
  });

  test('nothing from a script reaches the template', async () => {
    const { template } = await load([mixed]);
    const words = JSON.stringify(template.doc);
    assert.ok(!words.includes('alert'), 'script content stayed out of the document');
    assert.deepStrictEqual(
      layersOf(template.doc, 0).map((l) => l.type),
      ['text', 'rect'],
    );
  });

  test('the report the studio shows survives storage in the envelope', async () => {
    const { template, report } = await load([mixed]);
    assert.deepStrictEqual(template.origin.dropped, report.dropped);
  });

  test('a list longer than the maximum is cut, and says so', async () => {
    const many = Array.from({ length: 22 }, (_, i) =>
      headline(`slide-${String(i + 1).padStart(2, '0')}.svg`, `Slide ${i + 1}`),
    );
    const { template, report } = await load(many);
    assert.strictEqual(template.doc.slides.length, 20);
    assert.strictEqual(report.sourceSlides, 22);
    const cut = report.dropped.find((d) => /20-slide maximum/.test(d.what));
    assert.strictEqual(cut && cut.n, 2);
  });
});

describe('importSvg — the canvas', () => {
  test('16:9 lands in 1.91:1 with the margin named', async () => {
    const { template, report } = await load([
      file(
        'wide.svg',
        '<text x="100" y="100" font-size="40">Wide</text>',
        'viewBox="0 0 1920 1080"',
      ),
    ]);
    assert.strictEqual(template.doc.aspect, '1.91:1');
    assert.strictEqual(report.aspect.from, '16:9');
    assert.strictEqual(report.aspect.note, '16:9 fitted into 1.91:1 — 3% margin each side');
  });

  test('a forced aspect wins over the nearest one', async () => {
    const { template, report } = await load(
      [file('wide.svg', '<text x="100" y="100">Wide</text>', 'viewBox="0 0 1920 1080"')],
      { aspect: '1:1' },
    );
    assert.strictEqual(template.doc.aspect, '1:1');
    assert.match(report.aspect.note, /^16:9 fitted into 1:1 — \d+% margin top and bottom$/);
  });

  test('a viewBox that does not start at the origin still lands in the frame', async () => {
    const { template } = await load([
      file(
        'off.svg',
        '<rect x="-1000" y="-1250" width="1080" height="1350" fill="#ffffff"/>',
        'viewBox="-1000 -1250 1080 1350"',
      ),
    ]);
    assert.deepStrictEqual(typed(template.doc, 0, 'rect').box, { x: 0, y: 0, w: 1, h: 1 });
  });

  test('width and height stand in for a missing viewBox, units and all', async () => {
    const { template, report } = await load([
      file(
        'sized.svg',
        '<rect x="0" y="0" width="4in" height="5in" fill="#ffffff"/>',
        'width="4in" height="5in"',
      ),
    ]);
    assert.strictEqual(template.doc.aspect, '4:5');
    assert.deepStrictEqual(template.origin.srcSize, { w: 384, h: 480 });
    assert.strictEqual(report.aspect.margin, 0);
  });

  test('a file drawn on a different canvas is reported, not stretched to match', async () => {
    const { template, report } = await load([
      headline('slide-1.svg', 'One'),
      file(
        'slide-2.svg',
        '<rect x="0" y="0" width="1920" height="1080" fill="#ffffff"/>',
        'viewBox="0 0 1920 1080"',
      ),
    ]);
    assert.strictEqual(template.doc.aspect, '4:5');
    assert.ok(
      report.warnings.some((w) => /slide-2\.svg is drawn on 16:9, not the deck's 4:5/.test(w)),
      report.warnings.join('|'),
    );
    // Centred on its own terms: full width, and the margin is the mismatch.
    const rect = typed(template.doc, 1, 'rect');
    assert.ok(near(rect.box.w, 1) && rect.box.h < 1, JSON.stringify(rect.box));
  });
});

describe('importSvg — failures', () => {
  test('one unreadable file costs that slide, not the import', async () => {
    const { template, report } = await load([
      headline('a-first.svg', 'First'),
      { name: 'b-broken.svg', text: 'not an svg at all' },
      headline('c-third.svg', 'Third'),
    ]);
    assert.strictEqual(template.doc.slides.length, 2);
    assert.strictEqual(report.slides, 2);
    assert.strictEqual(report.sourceSlides, 3);
    assert.deepStrictEqual(
      template.doc.slides.map((s) => s.layers.find((l) => l.type === 'text').text),
      ['First', 'Third'],
    );
    assert.strictEqual(report.failed.length, 1);
    assert.strictEqual(report.failed[0].slide, 1);
    assert.strictEqual(report.failed[0].part, 'b-broken.svg');
    assert.match(report.failed[0].reason, /not an SVG document/);
  });

  test('a file with no canvas at all is named and skipped', async () => {
    const { report } = await load([
      headline('a.svg', 'One'),
      {
        name: 'b.svg',
        text: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
      },
    ]);
    assert.match(report.failed[0].reason, /states no viewBox and no size/);
  });

  test('a list of nothing readable is the import’s failure', async () => {
    await assert.rejects(load([{ name: 'a.svg', text: '<html><body>no</body></html>' }]), (err) => {
      assert.ok(err instanceof ImportError);
      assert.strictEqual(err.code, 'malformed');
      assert.match(err.message, /no SVG in this list could be read/);
      return true;
    });
  });

  test('an empty list says so rather than producing an empty deck', async () => {
    await assert.rejects(load([]), (err) => {
      assert.strictEqual(err.code, 'empty');
      assert.match(err.message, /no SVG file to import/);
      return true;
    });
  });

  test('a runtime with no DOMParser says so', async () => {
    const saved = globalThis.DOMParser;
    delete globalThis.DOMParser;
    try {
      await assert.rejects(load([headline('a.svg', 'One')]), (err) => {
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
      const { template } = await load([headline('a.svg', 'One')], { parser: DOMParser });
      assert.strictEqual(template.doc.slides.length, 1);
    } finally {
      globalThis.DOMParser = saved;
    }
  });

  test('a browser File reads through text(), and bytes decode as UTF-8', async () => {
    const source = headline('a.svg', 'Blob');
    const asFile = { name: 'a.svg', text: async () => source.text };
    const asBytes = { name: 'b.svg', bytes: new TextEncoder().encode(source.text) };
    const { template } = await load([asFile, asBytes]);
    assert.strictEqual(template.doc.slides.length, 2);
    assert.strictEqual(typed(template.doc, 1, 'text').text, 'Blob');
  });

  test('a file that cannot be read at all costs its slide and names why', async () => {
    const { report } = await load([
      headline('a.svg', 'One'),
      {
        name: 'b.svg',
        text: async () => {
          throw new Error('the file is gone');
        },
      },
    ]);
    assert.strictEqual(report.failed[0].part, 'b.svg');
    assert.match(report.failed[0].reason, /the file is gone/);
  });
});

describe('the natural filename order', () => {
  test('counts numbers as numbers', () => {
    const names = ['slide-10.svg', 'slide-2.svg', 'slide-1.svg', 'slide-20.svg'];
    assert.deepStrictEqual(
      [...names].sort(naturalOrder),
      ['slide-1.svg', 'slide-2.svg', 'slide-10.svg', 'slide-20.svg'],
    );
  });

  test('ignores case, which is not an ordering decision', () => {
    assert.deepStrictEqual(['B.svg', 'a.svg'].sort(naturalOrder), ['a.svg', 'B.svg']);
  });

  test('sorts on the words before it sorts on the numbers in them', () => {
    assert.deepStrictEqual(
      ['b1.svg', 'a10.svg', 'a2.svg'].sort(naturalOrder),
      ['a2.svg', 'a10.svg', 'b1.svg'],
    );
  });
});

describe('the import registry', () => {
  test('finds the adapter by extension, whatever the case', () => {
    const adapter = adapterFor('Cover.SVG');
    assert.strictEqual(adapter && adapter.format, 'svg');
    assert.strictEqual(adapter.read, importSvg);
    assert.strictEqual(adapter.takesList, true);
  });

  test('offers a file-input accept value covering every adapter', () => {
    for (const adapter of IMPORTERS) assert.ok(IMPORT_ACCEPT.includes(adapter.accept));
    assert.ok(IMPORT_ACCEPT.includes('.svg'));
  });
});
