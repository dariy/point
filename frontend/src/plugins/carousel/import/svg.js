/**
 * carousel/import/svg.js — a list of SVGs into a carousel template.
 *
 * The second import path, and the one that reaches the design tools PPTX does
 * not. Figma, Illustrator, Sketch and XD are proprietary on disk and all four
 * export SVG; Canva exports it too. Parsing is `DOMParser` and nothing else —
 * no ZIP, no npm dependency (`docs/vendors.md`).
 *
 * One SVG is one **slide**, because an SVG has no concept of a deck. The order
 * is a natural sort of the filenames — `slide-2` before `slide-10`, which a
 * plain string sort gets backwards — and the report states the order it chose,
 * so a person can see it guessed wrong and rename rather than wonder.
 *
 * ## The catch this importer exists to catch
 *
 * Canva and Figma both offer **"outline text on export"**, which turns every
 * headline into a `<path>`. The file still looks right in a browser and imports
 * without an error, and what you get is a template with no editable words in
 * it. A slide that comes back with no text and a pile of paths says so, by
 * name, in the report — see {@link OUTLINED_PATHS}.
 *
 * ## What it is not
 *
 * Not a renderer. The layer schema has five types (`document.js`) and SVG is a
 * general-purpose drawing language, so the honest translation is: map
 * `<rect>`, `<text>` and `<image>`, **count everything else**, and say so.
 * `<path>` and its friends are dropped with a count, not approximated by a box.
 *
 * The same four decisions the PPTX importer is built on hold here, and the
 * shared halves of them live in `adapter.js`: layers are built by
 * `normalizeLayer` and never by hand, the canvas fit is uniform and centred,
 * fonts are recorded rather than applied, and placeholders are not guessed.
 *
 * ## Untrusted input
 *
 * An imported SVG is a file from the internet and Point enforces Trusted Types.
 * Nothing here is ever inserted into the document: the file is parsed with
 * `DOMParser.parseFromString(text, 'image/svg+xml')` and the resulting tree is
 * only read, attribute by named attribute. `<script>` and `<foreignObject>` are
 * dropped by name rather than relied on to be absent, event-handler attributes
 * are never among the names this reads, and an `<image>` is kept only when it
 * is already an inline `data:` image — an external reference is a fetch this
 * import does not make.
 *
 * Schema: `docs/features/carousel-studio.md`.
 */

import { normalizeDocument, normalizeLayer, toTemplate } from '../document.js';
import { MAX_SLIDES } from '../studio/bounds.js';
import {
  ImportError,
  centreFit,
  coversCanvas,
  createAssets,
  createReport,
  fromDataUrl,
  metaFromFilename,
  ratioLabel,
} from './adapter.js';
import { attr, children, local, parseXml } from './xml.js';

/**
 * How many paths a slide with no text at all has to hold before this is called
 * outlined type rather than a piece of vector art. Eight is above a decorative
 * flourish or a logo — those arrive with the headline still a `<text>` — and far
 * below what one outlined word costs, which is a path per glyph.
 */
const OUTLINED_PATHS = 8;

/** CSS pixels per unit, for the absolute units an exporter writes on the root
 *  `<svg>`. A percentage has no pixel value without a viewport and is refused;
 *  `em` has none without a font, and 16 is the CSS initial one. */
const UNIT_PX = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 25.4 / 4,
  em: 16,
  rem: 16,
};

/** The CSS initial `font-size`, which is what an SVG `<text>` that states none
 *  is drawn at. */
const DEFAULT_FONT_PX = 16;

/** SVG's initial `fill` is black — not the schema's white, which is chosen for
 *  a mark over a photograph. A `<text>` that names no colour was drawn black
 *  and imports black. */
const DEFAULT_FILL = '#000000';

/** The gap between two `<tspan>` lines, as a multiple of the font size, when
 *  the file does not state one through `dy`. Matches the schema's own default. */
const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * How far above the baseline the em box's middle sits, as a fraction of the
 * font size. SVG positions type by its **baseline**; `render.js` paints a line
 * centred in its line box (`textBaseline = 'middle'`). This is the constant
 * that turns one into the other, and 0.35em is where the middle of a Latin em
 * box falls for the proportions every text face shares.
 */
const BASELINE_TO_MIDDLE = 0.35;

/** The properties this importer reads, from any of the three places CSS lets
 *  them be written. Everything else in a stylesheet is dropped and counted —
 *  this is not a rendering engine. */
const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'opacity',
  'display',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
];

/** The ones that inherit. `opacity` and `display` deliberately do not: a group
 *  at half opacity does not make each child half-opaque, it composites the
 *  group, and the schema has no group to composite. */
const INHERITED = new Set([
  'fill',
  'fill-opacity',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
]);

/** Elements that define rather than paint. Skipped in silence, because a
 *  `<defs>` holds the *definitions* of things whose use is what matters — a
 *  `clipPath` nobody references costs the design nothing, and reporting one
 *  would send a person hunting for something invisible. The references are
 *  counted instead, on the shape that carries them ({@link noteEffects}). */
const DEFINITIONS = new Set([
  'defs',
  'symbol',
  'marker',
  'linearGradient',
  'radialGradient',
  'pattern',
  'filter',
  'clipPath',
  'mask',
  'style',
  'title',
  'desc',
  'metadata',
]);

/** Containers whose children are painted in the parent's coordinate space, once
 *  their own transform is composed in. */
const GROUPS = new Set(['g', 'a', 'switch']);

/** What the report calls each thing the schema has no room for. A name a person
 *  recognises from their design tool, not a tag. */
const DROPPED = {
  path: 'path (a vector outline)',
  circle: 'circle',
  ellipse: 'ellipse',
  polygon: 'polygon',
  polyline: 'polyline',
  line: 'line',
  use: 'use (a copy of a defined shape)',
  foreignObject: 'embedded HTML',
  script: 'script (never imported)',
  svg: 'nested SVG',
  video: 'video',
  audio: 'audio',
};

/** `text-anchor` → the schema's `align`. The anchor is where the text sits
 *  relative to its point, which is exactly what `align` means inside a box. */
const TEXT_ALIGN = { start: 'left', middle: 'center', end: 'right' };

/** The `font-weight` keywords, as the numbers the schema stores. `lighter` and
 *  `bolder` are relative to an inherited weight this importer does not track;
 *  they take the nearest plain answer. */
const WEIGHTS = { normal: 400, bold: 700, lighter: 300, bolder: 700 };

/** `font-family` values that name no typeface. Recording one would put "the
 *  browser's default" in a list headed "fonts this template used". */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'inherit',
  'initial',
]);

/**
 * The colour keywords worth carrying. Not the full 147: an exporter writes hex
 * or `rgb()`, and a hand-edited file that says `white` or `black` is the case
 * worth not losing. Anything else is reported as a colour rather than guessed
 * at, which is the same rule the rest of this file follows.
 */
const NAMED_COLORS = {
  black: '#000000',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  navy: '#000080',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  teal: '#008080',
  aqua: '#00ffff',
  cyan: '#00ffff',
  maroon: '#800000',
  olive: '#808000',
};

const utf8 = new TextDecoder('utf-8');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * @typedef {object} SvgContext
 * @property {ReturnType<typeof createReport>} report
 * @property {import('./adapter.js').ImportAssets} assets
 * @property {{kept: number, total: number}} shapes
 * @property {Map<string, string>} images `href` → the `data:` URL it became, so
 *   a logo on eight slides is decoded, inlined and counted once
 */

/**
 * One slide under construction. The canvas and the fit are per file rather than
 * per deck: a file drawn on a different `viewBox` is centre-fitted on its own
 * terms into the deck's aspect and the difference is reported, which is the
 * honest answer when someone exports one slide at the wrong size.
 *
 * @typedef {object} SvgPage
 * @property {*} slide the document slide taking shape
 * @property {number} index
 * @property {string} name the file it came from
 * @property {{x: number, y: number, w: number, h: number}} canvas the `viewBox`
 * @property {import('./adapter.js').ImportFit} fit
 * @property {CssRule[]} css the file's own `<style>` rules, by specificity
 * @property {number} paths how many `<path>`s this slide dropped
 */

/**
 * @typedef {object} CssRule
 * @property {number} spec 0 for `*`, 1 for a tag, 2 for a class, 3 for an id
 * @property {'any'|'tag'|'class'|'id'} kind
 * @property {string} name
 * @property {Record<string, string>} decls
 */

/**
 * @typedef {object} SvgSource
 * @property {string} name the filename, which is where the order comes from
 * @property {string} text
 * @property {string} error why it could not be read at all, if it could not
 */

/**
 * Read an ordered list of SVGs into one storable template.
 *
 * Pure apart from `DOMParser`: no upload, no network, no canvas. Images the
 * files carry inline are re-inlined under `adapter.js`'s budget; turning those
 * into real post-owned media is the apply path's job.
 *
 * @param {Array<File|SvgSource|string>} files one SVG per slide. A browser
 *   `File`, a `{name, text}` pair, or bare SVG source — the dialog hands over
 *   the first, tests the second
 * @param {object} [options]
 * @param {string} [options.filename] what to call the deck; otherwise the
 *   files' common prefix names it
 * @param {string} [options.aspect] force a target aspect instead of the nearest
 * @param {typeof DOMParser} [options.parser] the seam a runtime without a
 *   global `DOMParser` supplies its own through
 * @param {number} [options.maxAssetBytes]
 * @param {number} [options.maxTotalBytes]
 * @returns {Promise<{template: import('../document.js').CarouselTemplate,
 *   report: import('./adapter.js').ImportReport}>}
 * @throws {ImportError} when there is no readable SVG in the list at all
 */
export async function importSvg(files, options = {}) {
  const parser = options.parser;
  if (typeof (parser || globalThis.DOMParser) !== 'function') {
    throw new ImportError('unsupported', 'this runtime has no DOMParser');
  }

  const sources = await readSources(files);
  if (!sources.length) throw new ImportError('empty', 'there is no SVG file to import');
  sources.sort((a, b) => naturalOrder(a.name, b.name));

  const names = sources.map((s) => s.name || '(unnamed)');
  const file = String(options.filename || '').trim() || deckFile(names);
  const report = createReport({ format: 'svg', file });
  if (sources.length > 1) {
    report.warn(
      `Slide order came from the filenames: ${listOf(names)}. ` +
        'Rename the files if that is not the order you meant.',
    );
  }
  if (sources.length > MAX_SLIDES) {
    report.drop(null, `slides past the ${MAX_SLIDES}-slide maximum`, sources.length - MAX_SLIDES);
  }

  const roots = readRoots(sources.slice(0, MAX_SLIDES), report, parser);
  const first = roots.find((r) => r);
  if (!first) throw new ImportError('malformed', 'no SVG in this list could be read');

  const deckFit = centreFit(first.canvas.w, first.canvas.h, options.aspect);
  /** @type {SvgContext} */
  const ctx = {
    report,
    assets: createAssets(report, options),
    shapes: { kept: 0, total: 0 },
    images: new Map(),
  };

  const slides = [];
  for (const [index, parsed] of roots.entries()) {
    if (parsed) slides.push(importOne(ctx, parsed, deckFit, index));
  }

  const faces = report.typefaces();
  if (faces.length) {
    report.warn(
      `Type is set by the blog theme, not by these files: ${listOf(faces)} ` +
        'recorded with the template, not applied.',
    );
  }

  const doc = normalizeDocument({ aspect: deckFit.aspect, mode: 'deck', slides, spanLayers: [] });
  const { id, name } = deckMeta(options.filename ? [file] : names);
  const template = toTemplate(doc, {
    id,
    name,
    origin: {
      format: 'svg',
      file,
      fonts: faces,
      srcSize: { w: first.canvas.w, h: first.canvas.h },
      dropped: report.drops(),
    },
  });

  return {
    template,
    report: report.finish({
      slides: doc.slides.length,
      sourceSlides: sources.length,
      shapes: ctx.shapes,
      aspect: deckFit.aspectReport,
      assets: ctx.assets.totals(),
      order: names,
    }),
  };
}

/**
 * Every file's text, in the order it was handed over. A file that cannot be
 * read carries its reason rather than throwing: the list still has to be sorted
 * and reported on, and one unreadable file costs that slide.
 *
 * @param {Array<File|SvgSource|string>} files
 * @returns {Promise<SvgSource[]>}
 */
async function readSources(files) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  /** @type {SvgSource[]} */
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      out.push({ name: '', text: entry, error: '' });
      continue;
    }
    const one = /** @type {*} */ (entry);
    const name = String(one.name || one.filename || '');
    try {
      out.push({ name, text: await textOf(one), error: '' });
    } catch (err) {
      out.push({ name, text: '', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * One entry's SVG source. A `File` reads through `text()`, a test's pair
 * through its own `text`, and bytes from anywhere decode as UTF-8 — which is
 * what an SVG is, and what its XML declaration says it is.
 *
 * @param {*} entry
 * @returns {Promise<string>}
 */
async function textOf(entry) {
  if (typeof entry.text === 'function') return stripBom(String(await entry.text()));
  if (typeof entry.text === 'string') return stripBom(entry.text);
  const bytes = entry.bytes || entry.data;
  if (bytes) {
    return stripBom(utf8.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  }
  throw new Error('holds no SVG text');
}

/** A byte-order mark ahead of `<svg` makes the document element `null`. */
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Parse each file, keeping the list's shape: a slot per source, `null` where
 * the file could not be read, so the deck's canvas can come from the first one
 * that could.
 *
 * @param {SvgSource[]} sources
 * @param {ReturnType<typeof createReport>} report
 * @param {typeof DOMParser} [parser]
 * @returns {Array<{root: Element, canvas: {x: number, y: number, w: number, h: number},
 *   name: string}|null>}
 */
function readRoots(sources, report, parser) {
  return sources.map((source, index) => {
    const name = source.name || `file ${index + 1}`;
    if (source.error) {
      report.fail(index, name, source.error);
      return null;
    }
    const root = parseXml(source.text, 'svg', parser, 'image/svg+xml');
    if (!root) {
      report.fail(index, name, 'is not an SVG document');
      return null;
    }
    const canvas = canvasOf(root);
    if (!canvas) {
      report.fail(index, name, 'states no viewBox and no size');
      return null;
    }
    return { root, canvas, name };
  });
}

/**
 * The source canvas: the `viewBox` when there is one, else `width`/`height` in
 * absolute units. The `viewBox` wins because it is the coordinate system every
 * number in the file is written in — `width` is only how big the author wanted
 * it on a page.
 *
 * @param {Element} root
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function canvasOf(root) {
  const box = String(attr(root, 'viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    return { x: box[0], y: box[1], w: box[2], h: box[3] };
  }
  const w = lengthOf(attr(root, 'width'), 0);
  const h = lengthOf(attr(root, 'height'), 0);
  return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
}

/**
 * One file into one slide.
 *
 * @param {SvgContext} ctx
 * @param {{root: Element, canvas: {x: number, y: number, w: number, h: number},
 *   name: string}} parsed
 * @param {import('./adapter.js').ImportFit} deckFit
 * @param {number} index the file's place in the list, which every report entry
 *   names — the source's index rather than the output's, so a file that failed
 *   does not renumber the ones after it
 * @returns {import('../document.js').CarouselSlide}
 */
function importOne(ctx, parsed, deckFit, index) {
  const { root, canvas, name } = parsed;
  const fit = centreFit(canvas.w, canvas.h, deckFit.aspect);
  if (fit.aspectReport.from !== deckFit.aspectReport.from) {
    ctx.report.warn(
      `${name} is drawn on ${ratioLabel(canvas.w, canvas.h)}, not the deck's ` +
        `${deckFit.aspectReport.from} — it was centred on its own rather than ` +
        'stretched to match.',
    );
  }

  /** @type {SvgPage} */
  const page = {
    slide: { source: '', fit: 'cover', bg: null, layers: [] },
    index,
    name,
    canvas,
    fit,
    css: readStyles(ctx, root, index),
    paths: 0,
  };

  walk(ctx, root, page, inheritable(styleOf(root, {}, page.css)), IDENTITY);

  if (page.paths > OUTLINED_PATHS && !page.slide.layers.some((l) => l.type === 'text')) {
    ctx.report.warn(
      `${name} has no text and ${page.paths} vector paths — this looks like text was ` +
        'outlined on export; re-export with outlining off to keep headlines editable.',
    );
  }
  return page.slide;
}

/**
 * Walk a container's children in document order, which for a drawing is paint
 * order and is meaning.
 *
 * @param {SvgContext} ctx
 * @param {Element} el
 * @param {SvgPage} page
 * @param {Record<string, string>} inherited the resolved style of `el`, cut
 *   down to the properties that inherit
 * @param {number[]} matrix `el`'s accumulated transform
 */
function walk(ctx, el, page, inherited, matrix) {
  for (const node of children(el)) {
    const tag = local(node);
    if (DEFINITIONS.has(tag)) continue;
    // Not a shape, and not counted as one: a script is a thing this refuses to
    // carry, not a piece of the design that did not fit.
    if (tag === 'script') {
      ctx.report.drop(page.index, DROPPED.script);
      continue;
    }

    const style = styleOf(node, inherited, page.css);
    if ((style.display || '').trim() === 'none') {
      ctx.report.drop(page.index, 'hidden element');
      continue;
    }
    const here = compose(matrix, attr(node, 'transform'));

    if (GROUPS.has(tag)) {
      // A group carries the effects in a Figma export: the drop shadow on a
      // card is a `filter` on the `<g>`, not on the rectangle inside it.
      noteEffects(ctx, node, page.index);
      walk(ctx, node, page, inheritable(style), here);
      continue;
    }
    ctx.shapes.total++;
    if (paint(ctx, node, tag, page, style, here)) ctx.shapes.kept++;
  }
}

/**
 * One painted element: a layer, the slide's own picture, or a count.
 *
 * @param {SvgContext} ctx
 * @param {Element} node
 * @param {string} tag
 * @param {SvgPage} page
 * @param {Record<string, string>} style
 * @param {number[]} matrix the transform in force, flattened only for a tag
 *   this can use one — reporting a lost rotation on a shape that is itself
 *   dropped would be two entries for one loss
 * @returns {boolean} whether it produced anything
 */
function paint(ctx, node, tag, page, style, matrix) {
  if (tag === 'rect' || tag === 'text' || tag === 'image') {
    noteEffects(ctx, node, page.index);
    const tf = frame(ctx, matrix, page);
    if (tag === 'rect') return importRect(ctx, node, page, style, tf);
    if (tag === 'text') return importText(ctx, node, page, style, tf);
    return importImage(ctx, node, page, style, tf);
  }
  if (tag === 'path') page.paths++;
  ctx.report.drop(page.index, DROPPED[/** @type {keyof typeof DROPPED} */ (tag)] || `<${tag}>`);
  return false;
}

/**
 * What was done to a shape that the schema cannot reproduce. The *reference* is
 * what gets counted, not the definition it points at — see {@link DEFINITIONS}.
 *
 * @param {SvgContext} ctx
 * @param {Element} node
 * @param {number} index
 */
function noteEffects(ctx, node, index) {
  if (attr(node, 'filter')) ctx.report.drop(index, 'filter (blur, shadow or glow)');
  if (attr(node, 'clip-path')) ctx.report.drop(index, 'clip path (imported uncropped)');
  if (attr(node, 'mask')) ctx.report.drop(index, 'mask (imported unmasked)');
}

/**
 * A `<rect>`: the schema's `rect` layer, or a count. This is the one SVG
 * element the schema has an exact answer for, corner radius and all.
 *
 * @param {SvgContext} ctx
 * @param {Element} node
 * @param {SvgPage} page
 * @param {Record<string, string>} style
 * @param {{sx: number, sy: number, tx: number, ty: number}} tf
 * @returns {boolean}
 */
function importRect(ctx, node, page, style, tf) {
  const w = lengthOf(attr(node, 'width'), 0);
  const h = lengthOf(attr(node, 'height'), 0);
  if (!(w > 0 && h > 0)) {
    ctx.report.drop(page.index, 'rectangle with no size');
    return false;
  }
  const filled = colorOf(style.fill === undefined ? DEFAULT_FILL : style.fill);
  if (!filled) {
    ctx.report.drop(page.index, fillNote(style.fill));
    return false;
  }
  const rect = placed(tf, lengthOf(attr(node, 'x'), 0), lengthOf(attr(node, 'y'), 0), w, h);
  // `rx`/`ry` are the two axes of an elliptical corner and the schema has one
  // radius; the horizontal one wins, and the shorter side is what both this and
  // the schema measure a corner against.
  const corner = lengthOf(attr(node, 'rx'), lengthOf(attr(node, 'ry'), 0)) * tf.sx;
  return addLayer(ctx, page, {
    type: 'rect',
    box: boxOf(page, rect),
    fill: filled.color,
    opacity: opacityOf(style, filled.alpha),
    radius: corner > 0 ? clamp(corner / Math.min(rect.w, rect.h), 0, 0.5) : 0,
  });
}

/**
 * A `<text>`: the schema's `text` layer.
 *
 * SVG positions type at a **point** — a baseline and an anchor — where the
 * schema gives it a **box** and aligns inside it. The translation keeps the
 * point exactly where the design put it and lets the box grow away from it: a
 * left-anchored headline gets the width from its anchor to the right edge of
 * the canvas, a centred one the widest box that stays centred on its point.
 * The type is set at the file's own size, so nothing reflows to a width the
 * author never chose; the box only says where the words may go.
 *
 * @param {SvgContext} ctx
 * @param {Element} node
 * @param {SvgPage} page
 * @param {Record<string, string>} style
 * @param {{sx: number, sy: number, tx: number, ty: number}} tf
 * @returns {boolean}
 */
function importText(ctx, node, page, style, tf) {
  const lines = linesOf(node);
  if (!lines.length) {
    ctx.report.drop(page.index, 'text with no words in it');
    return false;
  }
  recordFonts(ctx, style['font-family']);

  const size = lengthOf(style['font-size'], DEFAULT_FONT_PX) * tf.sy;
  const lineHeight = lineHeightOf(node, size / tf.sy);
  const align = TEXT_ALIGN[/** @type {keyof typeof TEXT_ALIGN} */ (style['text-anchor'])] || 'left';
  const anchor = placed(tf, anchorOf(node, 'x'), anchorOf(node, 'y'), 0, 0);
  const filled = colorOf(style.fill === undefined ? DEFAULT_FILL : style.fill) || {
    color: DEFAULT_FILL,
    alpha: 1,
  };

  const span = widthFrom(page.canvas, anchor.x, align);
  const height = lines.length * lineHeight * size;
  return addLayer(ctx, page, {
    type: 'text',
    box: boxOf(page, {
      x: span.x,
      // The first line's baseline is where the file put it: back off the half
      // line box `render.js` centres a line in, and the em box's own middle.
      y: anchor.y - (BASELINE_TO_MIDDLE + lineHeight / 2) * size,
      w: span.w,
      h: height,
    }),
    text: lines.join('\n'),
    size: page.fit.height(size),
    weight: weightOf(style['font-weight']),
    color: withAlpha(filled.color, opacityOf(style, filled.alpha)),
    align,
    valign: 'top',
    lineHeight: clamp(lineHeight, 0.5, 4),
  });
}

/**
 * An `<image>`: the slide's own photograph when it covers the canvas, an
 * `image` layer when it does not. The full-frame case is the mapping that makes
 * an imported template *useful* — the slide's source is what `applyTemplate`
 * replaces with the post's picture, so a background photo has to land there.
 *
 * @param {SvgContext} ctx
 * @param {Element} node
 * @param {SvgPage} page
 * @param {Record<string, string>} style
 * @param {{sx: number, sy: number, tx: number, ty: number}} tf
 * @returns {boolean}
 */
function importImage(ctx, node, page, style, tf) {
  const w = lengthOf(attr(node, 'width'), 0);
  const h = lengthOf(attr(node, 'height'), 0);
  if (!(w > 0 && h > 0)) {
    ctx.report.drop(page.index, 'image with no size');
    return false;
  }
  const url = inlineImage(ctx, attr(node, 'href') || '', page.index);
  if (!url) return false;

  const rect = placed(tf, lengthOf(attr(node, 'x'), 0), lengthOf(attr(node, 'y'), 0), w, h);
  const opacity = opacityOf(style, 1);
  // `slice` fills the box and crops; the default `meet` fits inside it. Those
  // are the schema's two fits, under other names.
  const cover = /\bslice\b/.test(attr(node, 'preserveAspectRatio') || '');

  const onCanvas = { x: rect.x - page.canvas.x, y: rect.y - page.canvas.y, w: rect.w, h: rect.h };
  if (coversCanvas(onCanvas, page.canvas.w, page.canvas.h) && !page.slide.source) {
    page.slide.source = url;
    page.slide.fit = cover ? 'cover' : 'contain';
    // A slide's pixels have no opacity in the schema — only a layer does.
    if (opacity < 1) ctx.report.drop(page.index, 'image transparency on the slide photo');
    return true;
  }
  return addLayer(ctx, page, {
    type: 'image',
    box: boxOf(page, rect),
    source: url,
    fit: cover ? 'cover' : 'contain',
    opacity,
  });
}

/**
 * The `data:` URL for an `<image href>`, or `''` when there is nothing to
 * inline — which the report already names.
 *
 * An external reference is refused rather than fetched: an import is not a
 * crawler, and a template whose logo is a URL on someone else's server is a
 * template that breaks when they tidy up. Identical hrefs are inlined once, so
 * a logo on eight slides costs the budget once.
 *
 * @param {SvgContext} ctx
 * @param {string} href
 * @param {number} index
 * @returns {string}
 */
function inlineImage(ctx, href, index) {
  const already = ctx.images.get(href);
  if (already !== undefined) return already;

  /** @param {string} why */
  const refuse = (why) => {
    ctx.report.drop(index, why);
    ctx.images.set(href, '');
    return '';
  };
  if (!href) return refuse('image with no source');
  if (!/^data:/i.test(href.trim())) return refuse('image stored outside the file');

  const decoded = fromDataUrl(href.trim(), `image-${ctx.images.size + 1}`);
  if (!decoded) return refuse('image Point cannot store: inline data in a format it cannot decode');

  const url = ctx.assets.inline(decoded.name, decoded.bytes, index);
  ctx.images.set(href, url);
  return url;
}

/**
 * Add a layer, normalized. Returns whether it survived — a layer the schema
 * rejects is counted rather than repaired, because the alternative is this
 * module deciding what a layer may be, which is `document.js`'s job.
 *
 * @param {SvgContext} ctx
 * @param {SvgPage} page
 * @param {*} layer
 * @returns {boolean}
 */
function addLayer(ctx, page, layer) {
  const normal = normalizeLayer(layer);
  if (!normal) {
    ctx.report.drop(page.index, `${layer && layer.type} the layer schema rejected`);
    return false;
  }
  page.slide.layers.push(normal);
  return true;
}

/**
 * A rectangle in the file's own units as a normalized layer box. The `viewBox`
 * origin comes off here and only here: everything upstream works in the
 * coordinates the file is written in.
 *
 * @param {SvgPage} page
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @returns {{x: number, y: number, w: number, h: number}} pre-normalization —
 *   no `rotate` yet; {@link normalizeLayer} fills it in
 */
function boxOf(page, rect) {
  return page.fit.box(rect.x - page.canvas.x, rect.y - page.canvas.y, rect.w, rect.h);
}

/**
 * The text box's horizontal extent: from the anchor to the far edge of the
 * canvas, on whichever side the alignment sends the words. A centred anchor
 * takes the widest box that keeps the anchor at its middle, which is what
 * "centred" means — and what keeps a second line under the first.
 *
 * @param {{x: number, w: number}} canvas
 * @param {number} x the anchor, in file units
 * @param {string} align
 * @returns {{x: number, w: number}}
 */
function widthFrom(canvas, x, align) {
  const left = canvas.x;
  const right = canvas.x + canvas.w;
  if (align === 'center') {
    const half = Math.min(x - left, right - x);
    if (half > 0) return { x: x - half, w: half * 2 };
  } else if (align === 'right') {
    if (x - left > 0) return { x: left, w: x - left };
  } else if (right - x > 0) {
    return { x, w: right - x };
  }
  // The anchor sits on or outside the edge it was aligned towards: the file is
  // drawing off-canvas, and the whole width is the least wrong box for it.
  return { x: left, w: canvas.w };
}

/**
 * A `<text>`'s lines. A `<tspan>` that states its own `x` or `dy` is a new line
 * — which is how every exporter writes wrapped type, since SVG does not wrap —
 * and a `<text>` with no such spans is one line however many spans style it.
 *
 * Whitespace collapses, because that is what XML content in an SVG means
 * without `xml:space="preserve"`: the indentation of the markup is not part of
 * the headline.
 *
 * @param {Element} node
 * @returns {string[]}
 */
function linesOf(node) {
  const spans = children(node, 'tspan').filter(
    (s) => attr(s, 'x') !== null || attr(s, 'dy') !== null,
  );
  const raw = spans.length ? spans.map((s) => s.textContent || '') : [node.textContent || ''];
  return raw.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * The line spacing a file states through the first line break's `dy`, as the
 * multiple of the font size the schema stores. `em` is read as the multiple it
 * already is; a length is read against the type size. No `dy` at all — an
 * exporter that gives every line its own `y` — means the schema's own default,
 * which is what those lines were spaced at anyway.
 *
 * @param {Element} node
 * @param {number} size the font size in the element's own units
 * @returns {number}
 */
function lineHeightOf(node, size) {
  const raw = children(node, 'tspan')
    .map((span) => attr(span, 'dy'))
    .find((value) => value !== null && value.trim() !== '');
  if (!raw) return DEFAULT_LINE_HEIGHT;
  const em = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*em\s*$/i.exec(raw);
  if (em) return Math.abs(Number(em[1])) || DEFAULT_LINE_HEIGHT;
  const dy = Math.abs(lengthOf(raw, 0));
  return dy > 0 && size > 0 ? dy / size : DEFAULT_LINE_HEIGHT;
}

/**
 * Where a `<text>` is anchored on one axis: its own coordinate, or the first
 * `<tspan>`'s when the element leaves the position to its spans.
 *
 * @param {Element} node
 * @param {'x'|'y'} axis
 * @returns {number}
 */
function anchorOf(node, axis) {
  const own = attr(node, axis);
  if (own !== null) return lengthOf(own, 0);
  const span = children(node, 'tspan').find((s) => attr(s, axis) !== null);
  return span ? lengthOf(attr(span, axis), 0) : 0;
}

/**
 * Every typeface a `font-family` names, into the report and nowhere else. The
 * whole stack is recorded rather than just the first: a stack is what the
 * author chose, and the fallbacks are as much a fact about the design as the
 * head of it.
 *
 * @param {SvgContext} ctx
 * @param {string|undefined} family
 */
function recordFonts(ctx, family) {
  for (const one of String(family || '').split(',')) {
    const name = one.trim().replace(/^['"]|['"]$/g, '');
    if (name && !GENERIC_FAMILIES.has(name.toLowerCase())) ctx.report.font(name);
  }
}

/**
 * The style in force on an element: what it inherits, then its presentation
 * attributes, then the stylesheet's rules by specificity, then its own `style`
 * attribute. That is CSS's own order — a presentation attribute is the weakest
 * author-level rule there is — and getting it backwards is how an Illustrator
 * file, which states a colour in both places, imports the wrong one.
 *
 * @param {Element} el
 * @param {Record<string, string>} inherited
 * @param {CssRule[]} css
 * @returns {Record<string, string>}
 */
function styleOf(el, inherited, css) {
  /** @type {Record<string, string>} */
  const out = { ...inherited };
  for (const prop of STYLE_PROPS) {
    const value = attr(el, prop);
    if (value !== null && value.trim() !== '') out[prop] = value.trim();
  }
  for (const rule of css) {
    if (matches(el, rule)) Object.assign(out, rule.decls);
  }
  Object.assign(out, parseDecls(attr(el, 'style') || ''));
  return out;
}

/** The half of a resolved style that passes to children. @param {Record<string,string>} style */
function inheritable(style) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(style)) {
    if (INHERITED.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Does this rule apply to this element? Four selector shapes, because four is
 * what an exporter writes — `.cls-1` from Illustrator, `text` from a
 * hand-written file, `#id` from Sketch, `*` from a reset.
 *
 * @param {Element} el
 * @param {CssRule} rule
 * @returns {boolean}
 */
function matches(el, rule) {
  if (rule.kind === 'any') return true;
  if (rule.kind === 'tag') return local(el) === rule.name;
  if (rule.kind === 'id') return (attr(el, 'id') || '') === rule.name;
  return String(attr(el, 'class') || '')
    .split(/\s+/)
    .includes(rule.name);
}

/**
 * The file's `<style>` rules, weakest selector first, so applying them in order
 * lets the strongest win.
 *
 * @param {SvgContext} ctx
 * @param {Element} root
 * @param {number} index
 * @returns {CssRule[]}
 */
function readStyles(ctx, root, index) {
  /** @type {CssRule[]} */
  const rules = [];
  for (const el of allStyleElements(root)) {
    rules.push(...parseCss(el.textContent || '', (what) => ctx.report.drop(index, what)));
  }
  // Sorted by specificity alone: `sort` is stable, so rules of equal weight
  // keep the order the sheet wrote them in, which is the tie-break CSS uses.
  return rules.sort((a, b) => a.spec - b.spec);
}

/** Every `<style>` in the document, wherever it was put — the root, a `<defs>`,
 *  or inside a group, all of which are legal and all of which exporters use.
 *  @param {Element} el @returns {Element[]} */
function allStyleElements(el) {
  /** @type {Element[]} */
  const out = [];
  for (const kid of children(el)) {
    if (local(kid) === 'style') out.push(kid);
    else out.push(...allStyleElements(kid));
  }
  return out;
}

/**
 * A stylesheet as the handful of rules this reads. Scanned by brace depth
 * rather than by one regular expression so that an `@media` block — whose body
 * holds braces of its own — is skipped whole instead of shedding its inner
 * rules into the sheet.
 *
 * @param {string} source
 * @param {(what: string) => void} note what to call something this cannot read
 * @returns {Array<{spec: number, kind: 'any'|'tag'|'class'|'id', name: string,
 *   decls: Record<string, string>}>}
 */
function parseCss(source, note) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    if (open < 0) break;
    const selectors = text.slice(at, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < text.length && depth > 0) {
      if (text[close] === '{') depth++;
      else if (text[close] === '}') depth--;
      close++;
    }
    const body = text.slice(open + 1, close - 1);
    at = close;

    if (!selectors || selectors.startsWith('@')) {
      note('CSS at-rule Point does not read');
      continue;
    }
    const decls = parseDecls(body);
    for (const one of selectors.split(',')) {
      const sel = selectorOf(one.trim());
      if (sel) rules.push({ ...sel, decls });
      else note('CSS selector Point does not read');
    }
  }
  return rules;
}

/**
 * A selector this can match, or `null` for one it cannot. Deliberately only the
 * four simple shapes: a descendant or attribute selector would need a matching
 * engine, and the properties at stake are a fill and a font size.
 *
 * @param {string} selector
 * @returns {{spec: number, kind: 'any'|'tag'|'class'|'id', name: string}|null}
 */
function selectorOf(selector) {
  if (selector === '*') return { spec: 0, kind: 'any', name: '' };
  if (/^[a-z][a-z0-9]*$/i.test(selector)) return { spec: 1, kind: 'tag', name: selector };
  if (/^\.[\w-]+$/.test(selector)) return { spec: 2, kind: 'class', name: selector.slice(1) };
  if (/^#[\w-]+$/.test(selector)) return { spec: 3, kind: 'id', name: selector.slice(1) };
  return null;
}

/**
 * A declaration block as a plain object, keeping only what this file reads.
 * `!important` is stripped rather than honoured: with four sources of a value
 * and no cascade beyond them, honouring it would be a second ordering rule for
 * a case an exporter does not write.
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
function parseDecls(body) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const decl of String(body).split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).replace(/!important\s*$/i, '').trim();
    if (value && STYLE_PROPS.includes(prop)) out[prop] = value;
  }
  return out;
}

/** The identity transform, as SVG writes one: `a b c d e f`. */
const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * `m` with `value` applied inside it — the child's transform runs first, then
 * the parent's, which is the order a nested `transform` attribute means.
 *
 * @param {number[]} m
 * @param {string|null} value
 * @returns {number[]}
 */
function compose(m, value) {
  let out = m;
  for (const [, name, args] of String(value || '').matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)) {
    const n = args.trim().split(/[\s,]+/).map(Number);
    if (n.some((v) => !Number.isFinite(v))) continue;
    const step = transformOf(name.toLowerCase(), n);
    if (step) out = multiply(out, step);
  }
  return out;
}

/**
 * One transform function as a matrix.
 *
 * @param {string} name
 * @param {number[]} n
 * @returns {number[]|null}
 */
function transformOf(name, n) {
  const rad = (deg) => (deg * Math.PI) / 180;
  if (name === 'matrix' && n.length === 6) return n;
  if (name === 'translate') return [1, 0, 0, 1, n[0] || 0, n.length > 1 ? n[1] : 0];
  if (name === 'scale') return [n[0] || 0, 0, 0, n.length > 1 ? n[1] : n[0] || 0, 0, 0];
  if (name === 'rotate') {
    const [cos, sin] = [Math.cos(rad(n[0] || 0)), Math.sin(rad(n[0] || 0))];
    const turn = [cos, sin, -sin, cos, 0, 0];
    if (n.length < 3) return turn;
    // Around a point: out to it, turn, back.
    return multiply(multiply([1, 0, 0, 1, n[1], n[2]], turn), [1, 0, 0, 1, -n[1], -n[2]]);
  }
  if (name === 'skewx') return [1, 0, Math.tan(rad(n[0] || 0)), 1, 0, 0];
  if (name === 'skewy') return [1, Math.tan(rad(n[0] || 0)), 0, 1, 0, 0];
  return null;
}

/** `m` then `n`, in SVG's six-number order. @param {number[]} m @param {number[]} n */
function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/**
 * A transform as the scale-and-offset a box can carry, reporting whatever did
 * not survive the flattening.
 *
 * A translate, a scale and any composition of the two are **exact** here. A
 * rotation or a skew is not — the schema's box has no angle — so the shape
 * keeps its size and its place and loses its angle, which is visibly wrong in
 * one specific way the report can name rather than invisibly wrong. A mirror
 * loses its handedness the same way, for the same reason: reflecting a box
 * about its own centre is a change the schema cannot state.
 *
 * @param {SvgContext} ctx
 * @param {number[]} m
 * @param {SvgPage} page
 * @returns {{sx: number, sy: number, tx: number, ty: number}}
 */
function frame(ctx, m, page) {
  if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) {
    ctx.report.drop(page.index, 'rotation or skew (imported square)');
  }
  if (m[0] * m[3] - m[1] * m[2] < 0) ctx.report.drop(page.index, 'flip (imported unflipped)');
  return {
    sx: Math.hypot(m[0], m[1]) || 1,
    sy: Math.hypot(m[2], m[3]) || 1,
    tx: m[4],
    ty: m[5],
  };
}

/** A rectangle in its element's coordinates, moved into the file's.
 *  @param {{sx: number, sy: number, tx: number, ty: number}} tf */
function placed(tf, x, y, w, h) {
  return { x: tf.tx + tf.sx * x, y: tf.ty + tf.sy * y, w: tf.sx * w, h: tf.sy * h };
}

/**
 * A CSS length in user units, or `fallback`. A percentage is refused: it means
 * a fraction of a viewport this importer is not laying out, and guessing which
 * one would move a shape.
 *
 * @param {string|null|undefined} value
 * @param {number} [fallback]
 * @returns {number}
 */
function lengthOf(value, fallback = 0) {
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(
    String(value ?? ''),
  );
  if (!match) return fallback;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return fallback;
  const unit = match[2].toLowerCase();
  if (!unit) return n;
  const per = UNIT_PX[/** @type {keyof typeof UNIT_PX} */ (unit)];
  return per ? n * per : fallback;
}

/**
 * A paint value as a colour the schema takes, or `null` for one it does not —
 * which includes `none`, a gradient reference and `currentColor`, three
 * different ways of saying "not a colour written here".
 *
 * @param {string|undefined} value
 * @returns {{color: string, alpha: number}|null}
 */
function colorOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(raw)) return { color: raw, alpha: 1 };
  if (NAMED_COLORS[/** @type {keyof typeof NAMED_COLORS} */ (raw)]) {
    return { color: NAMED_COLORS[/** @type {keyof typeof NAMED_COLORS} */ (raw)], alpha: 1 };
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(raw);
  if (!rgb) return null;
  const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
  const hex = parts
    .slice(0, 3)
    .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
    .join('');
  const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? clamp(parts[3], 0, 1) : 1;
  return { color: `#${hex}`, alpha };
}

/** What to call a fill that produced no colour. @param {string|undefined} raw */
function fillNote(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value.startsWith('url(')) return 'gradient or pattern fill';
  if (value === 'none' || value === 'transparent') return 'shape with no fill';
  return `shape with a colour Point could not read: ${value || 'none stated'}`;
}

/**
 * The element's own opacity: `opacity`, `fill-opacity` and any alpha the colour
 * carried, multiplied — the three ways a design tool writes the same thing.
 *
 * @param {Record<string, string>} style
 * @param {number} alpha
 * @returns {number}
 */
function opacityOf(style, alpha) {
  const one = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return 1;
    const n = Number(raw.replace(/%$/, ''));
    if (!Number.isFinite(n)) return 1;
    return clamp(raw.endsWith('%') ? n / 100 : n, 0, 1);
  };
  return clamp(one(style.opacity) * one(style['fill-opacity']) * alpha, 0, 1);
}

/**
 * A colour with an opacity folded into its alpha channel — how a `text` layer
 * carries one, since only three of the five layer types have an `opacity`
 * field. A fully opaque colour is left as it was written.
 *
 * @param {string} color
 * @param {number} opacity
 * @returns {string}
 */
function withAlpha(color, opacity) {
  if (opacity >= 1 || color.length > 7) return color;
  const hex = clamp(Math.round(opacity * 255), 0, 255).toString(16).padStart(2, '0');
  // `#rgb` takes a one-digit alpha, `#rrggbb` a two-digit one.
  return color.length === 4 ? `${color}${hex[0]}` : `${color}${hex}`;
}

/** A `font-weight` as the number the schema stores. @param {string|undefined} value */
function weightOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  const named = WEIGHTS[/** @type {keyof typeof WEIGHTS} */ (raw)];
  if (named) return named;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

/**
 * Filenames in the order a person means them: `slide-2` before `slide-10`,
 * which a plain string sort gets backwards, and case-insensitively, because a
 * capital letter in a filename is not an ordering decision.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function naturalOrder(a, b) {
  const parts = (name) => String(name || '').toLowerCase().match(/\d+|\D+/g) || [];
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const numeric = /^\d/.test(l) && /^\d/.test(r);
    if (numeric && Number(l) !== Number(r)) return Number(l) - Number(r);
    if (!numeric && l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** A filename without its directory or its extension. @param {string} name */
const baseOf = (name) =>
  String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '');

/**
 * What to call a deck of several files: their common prefix with any trailing
 * counter taken off, so `slide-01.svg`…`slide-09.svg` is "slide" rather than
 * the first file's name. One file names itself.
 *
 * @param {string[]} names
 * @returns {{id: string, name: string}}
 */
function deckMeta(names) {
  if (names.length < 2) return metaFromFilename(names[0] || '');
  const bases = names.map(baseOf);
  let prefix = bases[0];
  for (const base of bases.slice(1)) {
    while (prefix && !base.toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1);
    }
  }
  return metaFromFilename(prefix.replace(/[\s._-]*\d*$/, '').trim() || bases[0]);
}

/** What the report calls the import: the file, when there is one of them.
 *  @param {string[]} names */
const deckFile = (names) => (names.length === 1 ? names[0] : `${names.length} SVG files`);

/** Up to three names and a count for the rest, for a sentence a person reads.
 *  @param {string[]} names */
function listOf(names) {
  const head = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${head} and ${names.length - 3} more` : head;
}
