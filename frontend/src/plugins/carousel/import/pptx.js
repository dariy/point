/**
 * carousel/import/pptx.js — a `.pptx` deck into a carousel template.
 *
 * This is the main import path, and it is one importer for what looks like two
 * jobs: PPTX is what a PowerPoint template already is, and it is also what
 * **Canva** hands you — Canva's manual download offers PPTX for a presentation,
 * and the Connect API's export formats are PDF, JPG, PNG, GIF, PPTX, MP4, CSV.
 * So "Instagram templates from Canva" and "PowerPoint templates" turn out to be
 * the same feature.
 *
 * OOXML is ECMA-376 and openly specified, a `.pptx` is a ZIP of XML, and
 * `docs/vendors.md` allows the frontend no npm runtime dependency — so this
 * reads one with `./zip.js` and `DOMParser` and nothing else.
 *
 * ## What it is not
 *
 * Not a renderer, and not a PowerPoint. The carousel layer schema has five
 * types (`document.js`), and the honest translation of a deck is: take what
 * maps, **count what does not**, and say so. An import that silently lost half
 * a design is worse than one that reports keeping 14 of 22 shapes, so every
 * unmappable shape, effect and rotation lands in `report.dropped` with its
 * slide, a name and a count.
 *
 * Four decisions carry the rest of the file:
 *
 * - **Layers are built by `normalizeLayer`, never by hand.** An importer that
 *   assembles its own layer objects is a second way to author a layer, and that
 *   is how a schema grows two dialects. A shape the schema rejects is counted,
 *   not repaired.
 * - **The fit is uniform and centred** (`adapter.js` `centreFit`). 16:9 is the
 *   common PowerPoint case against Point's widest 1.91:1; the deck arrives with
 *   a margin each side and the report names it, rather than arriving squashed.
 * - **Fonts are recorded, not applied.** `<a:latin typeface>` values go into
 *   `origin.fonts` and nowhere else. The layer schema gains no font field, so
 *   paint time is unchanged and type stays in the blog theme's family.
 * - **Placeholders are not guessed.** Text arrives literal. Deciding that the
 *   biggest text box on slide 1 "is" `{title}` would be wrong exactly when it
 *   mattered; the author turns a headline into a placeholder in the studio,
 *   where they can see it.
 *
 * A malformed part costs **that slide**, not the import: the deck comes back
 * short with the failure named, the same reasoning as a broken `image` layer in
 * S3. Schema: `docs/features/carousel-studio.md`.
 */

import { normalizeDocument, normalizeLayer, toTemplate } from '../document.js';
import { MAX_SLIDES } from '../studio/bounds.js';
import { openZip, ZipError } from './zip.js';
import {
  ImportError,
  centreFit,
  createAssets,
  createReport,
  metaFromFilename,
} from './adapter.js';
import {
  attr,
  attrBool,
  attrNum,
  child,
  children,
  descendants,
  local,
  parseXml,
  path,
} from './xml.js';

/** English Metric Units, the unit every OOXML coordinate is in: 914400 to the
 *  inch, so 9525 to a CSS pixel at 96 dpi and 12700 to a point. */
const EMU_PER_PX = 9525;
const EMU_PER_POINT = 12700;

/** OOXML writes percentages as 1000ths of one — `50000` is 50%. */
const PER_CENT = 100000;

/** 60000ths of a degree, for `<a:lin ang>`. */
const PER_DEGREE = 60000;

/**
 * How much of the slide a shape has to cover to be treated as the slide's own
 * picture rather than as a layer over it. Generous on the offset because a
 * full-bleed photo is often placed a hair outside the slide.
 */
const FULL_FRAME = { cover: 0.95, offset: 0.05 };

/** The default corner on `roundRect` when the shape states no adjust value —
 *  16.667% of the shorter side, which is the preset's own default. */
const DEFAULT_ROUND = 16667;

const PRESENTATION = 'ppt/presentation.xml';

/** Presets the `rect` layer can honestly stand in for. Anything else — an
 *  ellipse, a triangle, a star — is counted, because a rectangle is not it. */
const RECT_PRESETS = new Set(['rect', 'roundRect']);

/** `<p:spTree>` children that are not shapes: the group's own name and
 *  properties, and the extension list. Counting them would make "kept 14 of 22"
 *  wrong by two on every slide. */
const NOT_A_SHAPE = new Set(['nvGrpSpPr', 'grpSpPr', 'extLst']);

/** `<a:graphicData uri>` prefixes, longest-lived part first. A graphic frame is
 *  always dropped; this is only so the report can say *what* was dropped. */
const GRAPHIC_KINDS = [
  ['/chart', 'chart'],
  ['/table', 'table'],
  ['/diagram', 'SmartArt diagram'],
  ['/ole', 'embedded object'],
];

/**
 * Scheme colour names to `<a:clrScheme>` children. `tx1`/`bg1` are the aliases
 * a slide actually writes; `dk1`/`lt1` are what the theme calls the same two
 * entries, and a deck may use either.
 */
const SCHEME_ALIAS = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

const TEXT_ALIGN = { l: 'left', ctr: 'center', r: 'right' };
const TEXT_ANCHOR = { t: 'top', ctr: 'middle', b: 'bottom' };

const utf8 = new TextDecoder('utf-8');

/**
 * @typedef {object} PptxContext
 * @property {import('./zip.js').ZipReader} zip
 * @property {typeof DOMParser|undefined} parser
 * @property {Map<string, string>} theme scheme colour name → `#rrggbb`
 * @property {import('./adapter.js').ImportFit} fit
 * @property {ReturnType<typeof createReport>} report
 * @property {import('./adapter.js').ImportAssets} assets
 * @property {{kept: number, total: number}} shapes
 * @property {number} srcW source canvas width, EMU
 * @property {number} srcH source canvas height, EMU
 */

/**
 * One slide under construction: the slide itself, its index in the deck (which
 * every report entry needs) and its relationships (which every image needs).
 * Bundled because all three travel together through every shape handler.
 *
 * @typedef {object} PptxPage
 * @property {*} slide the document slide taking shape
 * @property {number} index
 * @property {Map<string, string>} rels
 */

/**
 * Read a `.pptx` into a storable template.
 *
 * Pure apart from `DOMParser`: no upload, no network, no canvas. The images it
 * finds are inlined as `data:` URLs inside the envelope under `adapter.js`'s
 * budget; turning those into real post-owned media is the apply path's job, and
 * nothing on the render path ever learns about `data:`.
 *
 * @param {Uint8Array|ArrayBuffer} bytes the `.pptx` file
 * @param {object} [options]
 * @param {string} [options.filename] what the user called it — the template's
 *   name and slug come from this, and the report quotes it
 * @param {string} [options.aspect] force a target aspect instead of the nearest
 * @param {typeof DOMParser} [options.parser] the seam `zip.js` has for
 *   `DecompressionStream`, for the same reason: a runtime with no `DOMParser`
 *   should be testable rather than skipped
 * @param {number} [options.maxAssetBytes]
 * @param {number} [options.maxTotalBytes]
 * @returns {Promise<{template: import('../document.js').CarouselTemplate,
 *   report: import('./adapter.js').ImportReport}>}
 * @throws {ImportError} when the file is not a deck this can read at all
 */
export async function importPptx(bytes, options = {}) {
  const file = typeof options.filename === 'string' ? options.filename.trim() : '';
  const parser = options.parser;
  // Stated up front rather than discovered as "this is not a presentation" four
  // reads later — the same courtesy `zip.js` pays `DecompressionStream`.
  if (typeof (parser || globalThis.DOMParser) !== 'function') {
    throw new ImportError('unsupported', 'this runtime has no DOMParser');
  }

  const zip = openArchive(bytes);
  const { srcW, srcH, listed } = await readDeck(zip, parser);
  const report = createReport({ format: 'pptx', file });
  const fit = centreFit(srcW, srcH, options.aspect);
  /** @type {PptxContext} */
  const ctx = {
    zip,
    parser,
    theme: await readTheme(zip, parser),
    fit,
    report,
    assets: createAssets(report, options),
    shapes: { kept: 0, total: 0 },
    srcW,
    srcH,
  };

  const parts = await slideParts(zip, listed, report, parser);
  if (!parts.length) {
    throw new ImportError('malformed', 'names no slide this file contains', PRESENTATION);
  }
  if (parts.length > MAX_SLIDES) {
    report.drop(null, `slides past the ${MAX_SLIDES}-slide maximum`, parts.length - MAX_SLIDES);
  }
  const slides = await importSlides(ctx, parts.slice(0, MAX_SLIDES));

  const faces = report.typefaces();
  if (faces.length) {
    report.warn(
      `Type is set by the blog theme, not by this deck: ${named(faces)} ` +
        'recorded with the template, not applied.',
    );
  }

  const doc = normalizeDocument({ aspect: fit.aspect, mode: 'deck', slides, spanLayers: [] });
  const { id, name } = metaFromFilename(file);
  const template = toTemplate(doc, {
    id,
    name,
    origin: {
      format: 'pptx',
      file,
      fonts: faces,
      srcSize: { w: srcW / EMU_PER_PX, h: srcH / EMU_PER_PX },
      dropped: report.drops(),
    },
  });

  return {
    template,
    report: report.finish({
      slides: doc.slides.length,
      sourceSlides: listed.length,
      shapes: ctx.shapes,
      aspect: fit.aspectReport,
      assets: ctx.assets.totals(),
    }),
  };
}

/**
 * The deck-level facts: the canvas it was drawn on, and the slides it lists.
 *
 * Every failure here is the whole import's, because there is no deck without
 * them — which is the line this function draws. Everything after it costs at
 * most one slide.
 *
 * @param {import('./zip.js').ZipReader} zip
 * @param {typeof DOMParser} [parser]
 * @returns {Promise<{srcW: number, srcH: number, listed: Element[]}>}
 */
async function readDeck(zip, parser) {
  const pres = await readPart(zip, PRESENTATION, 'presentation', parser);
  if (!pres) throw new ImportError('malformed', 'is not a presentation', PRESENTATION);
  const size = child(pres, 'sldSz');
  const srcW = attrNum(size, 'cx', 0);
  const srcH = attrNum(size, 'cy', 0);
  if (srcW <= 0 || srcH <= 0) {
    throw new ImportError('malformed', 'states no slide size', PRESENTATION);
  }
  const listed = children(child(pres, 'sldIdLst'), 'sldId');
  if (!listed.length) throw new ImportError('empty', 'contains no slides', PRESENTATION);
  return { srcW, srcH, listed };
}

/**
 * Every slide, in order, each one's failure costing only itself. A deck where
 * *nothing* could be read is a different thing from a deck that came back
 * short, and is the import's failure.
 *
 * @param {PptxContext} ctx
 * @param {string[]} parts
 * @returns {Promise<import('../document.js').CarouselSlide[]>}
 */
async function importSlides(ctx, parts) {
  const slides = [];
  for (const [index, part] of parts.entries()) {
    try {
      slides.push(await importSlide(ctx, part, index));
    } catch (err) {
      ctx.report.fail(index, part, reasonOf(err));
    }
  }
  if (!slides.length) {
    throw new ImportError('malformed', 'no slide in this deck could be read');
  }
  return slides;
}

/** A thrown thing as a sentence for the report. @param {*} err */
const reasonOf = (err) => (err instanceof Error ? err.message : String(err));

/** Up to three names and a count for the rest, for a sentence a person reads.
 *  @param {string[]} names */
function named(names) {
  const head = names.slice(0, 3).join(', ');
  const list = names.length > 3 ? `${head} and ${names.length - 3} more` : head;
  return `${names.length} typeface${names.length === 1 ? '' : 's'} (${list})`;
}

/**
 * Open the archive, translating a ZIP failure into an import one so a caller
 * has a single error vocabulary to catch. The codes line up closely enough that
 * only the two "we will not read this" cases need folding together.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {import('./zip.js').ZipReader}
 */
function openArchive(bytes) {
  try {
    return openZip(bytes);
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    throw new ImportError(importCode(err.code), `not a readable .pptx — ${err.message}`);
  }
}

/**
 * One archive member as text. UTF-8 with the BOM dropped: PowerPoint writes
 * one, and `DOMParser` treats a leading `U+FEFF` as content sitting before the
 * declaration, which fails the parse.
 *
 * @param {import('./zip.js').ZipReader} zip
 * @param {string} part
 * @returns {Promise<string>}
 */
async function readText(zip, part) {
  return utf8.decode(await readBytes(zip, part)).replace(/^\uFEFF/, '');
}

/**
 * One archive member, translated into the import's own failure type — so a
 * corrupt member inside a slide costs that slide through the same catch as a
 * malformed one, and a caller has one error vocabulary rather than two.
 *
 * @param {import('./zip.js').ZipReader} zip
 * @param {string} part
 * @returns {Promise<Uint8Array>}
 */
async function readBytes(zip, part) {
  try {
    return await zip.read(part);
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    throw new ImportError(importCode(err.code), err.message);
  }
}

/**
 * A ZIP failure code as an import one. Only the two "we will not read this"
 * cases need folding together; the rest line up.
 *
 * @param {import('./zip.js').ZipErrorCode} code
 * @returns {import('./adapter.js').ImportErrorCode}
 */
function importCode(code) {
  if (code === 'too-large') return 'too-large';
  return code === 'zip64' || code === 'unsupported' ? 'unsupported' : 'malformed';
}

/**
 * Parse one XML member, or `null` when it is absent or is not the part it
 * claims to be. The caller decides what that costs — see `xml.js` `parseXml`.
 *
 * @param {import('./zip.js').ZipReader} zip
 * @param {string} part
 * @param {string} root expected root element, local name
 * @param {typeof DOMParser} [parser]
 * @returns {Promise<Element|null>}
 */
async function readPart(zip, part, root, parser) {
  if (!zip.has(part)) return null;
  return parseXml(await readText(zip, part), root, parser);
}

/**
 * A part's relationships: `rId` → the archive path it resolves to.
 *
 * External targets are skipped rather than resolved. A template that reached
 * out to `http://` for an image at render time would be a template that stops
 * working when someone else's server does, and inlining is the whole point of
 * the envelope.
 *
 * @param {import('./zip.js').ZipReader} zip
 * @param {string} part the part the relationships belong to
 * @param {typeof DOMParser} [parser]
 * @returns {Promise<Map<string, string>>}
 */
async function readRels(zip, part, parser) {
  const at = part.lastIndexOf('/');
  const dir = at < 0 ? '' : part.slice(0, at);
  const name = part.slice(at + 1);
  const root = await readPart(zip, `${dir}${dir ? '/' : ''}_rels/${name}.rels`, 'Relationships', parser);
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const rel of children(root, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (!id || !target) continue;
    if ((attr(rel, 'TargetMode') || '').toLowerCase() === 'external') continue;
    out.set(id, resolvePart(dir, target));
  }
  return out;
}

/**
 * Resolve a relationship target against the directory of the part that named
 * it — `ppt` + `../media/image2.png` → `media/image2.png`. `..` is dropped at
 * the root rather than escaping it; `zip.js` already refuses an archive whose
 * *entries* escape, and this is the other direction.
 *
 * @param {string} dir
 * @param {string} target
 * @returns {string}
 */
function resolvePart(dir, target) {
  // A leading slash means the package root; anything else is relative to the
  // directory of the part that named it.
  const out = target.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const segment of target.replace(/^\/+/, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * The slide parts, in the order the deck presents them.
 *
 * Order comes from `<p:sldIdLst>` through the relationships, **never** from
 * sorting filenames: `slide10.xml` sorts before `slide2.xml`, and the id list is
 * the only authority on order in any case — a deck whose slides were reordered
 * keeps its original part names.
 *
 * @param {import('./zip.js').ZipReader} zip
 * @param {Element[]} listed the `<p:sldId>` entries, in order
 * @param {ReturnType<typeof createReport>} report
 * @param {typeof DOMParser} [parser]
 * @returns {Promise<string[]>}
 */
async function slideParts(zip, listed, report, parser) {
  const rels = await readRels(zip, PRESENTATION, parser);
  const out = [];
  for (const [index, sldId] of listed.entries()) {
    const part = relFor(sldId, rels);
    if (part && zip.has(part)) out.push(part);
    else report.fail(index, part || PRESENTATION, 'the deck names a slide this file does not contain');
  }
  return out;
}

/**
 * The `r:id` relationship of a `<p:sldId>`, resolved to an archive path.
 *
 * Split out because the element carries two attributes whose name ends in `id`:
 * the deck's own slide number, which is not a link, and the relationship, which
 * is. Only the prefixed one will do — and the prefix itself is not assumed, for
 * `xml.js`'s reason.
 *
 * @param {Element} sldId
 * @param {Map<string, string>} rels
 * @returns {string}
 */
function relFor(sldId, rels) {
  const attrs = sldId.attributes;
  for (let i = 0; i < (attrs ? attrs.length : 0); i++) {
    const a = attrs[i];
    if (a.name.includes(':') && a.name.endsWith(':id')) return rels.get(a.value) || '';
  }
  return '';
}

/**
 * The theme's colour scheme, so a shape that says `schemeClr val="accent1"`
 * imports as the colour it looks like rather than as nothing.
 *
 * Colour *transforms* — `lumMod`, `shade`, `tint` — are deliberately ignored:
 * the base colour is right to within a shade, and reimplementing DrawingML's
 * colour algebra to get the shade exact would be a rendering engine, which this
 * is not. Best effort throughout: a deck with no readable theme simply resolves
 * fewer colours.
 *
 * @param {import('./zip.js').ZipReader} zip
 * @param {typeof DOMParser} [parser]
 * @returns {Promise<Map<string, string>>}
 */
async function readTheme(zip, parser) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const part =
    zip.names().find((n) => n === 'ppt/theme/theme1.xml') ||
    zip.names().find((n) => n.startsWith('ppt/theme/') && n.endsWith('.xml'));
  if (!part) return out;
  let root = null;
  try {
    root = await readPart(zip, part, 'theme', parser);
  } catch {
    return out;
  }
  const scheme = path(root, 'themeElements', 'clrScheme');
  for (const entry of children(scheme)) {
    const color = readColor(entry, out);
    if (color) out.set(local(entry), color.color);
  }
  return out;
}

/**
 * A DrawingML colour, resolved: `#rrggbb` plus the alpha that sat on it.
 *
 * The first child that resolves wins, because a fill holds exactly one colour
 * element and the others are the sibling variants this does not read.
 *
 * @param {Element|null} holder the element a `<a:*Clr>` sits inside
 * @param {Map<string, string>} theme
 * @returns {{color: string, opacity: number}|null}
 */
function readColor(holder, theme) {
  for (const el of children(holder)) {
    const resolved = colorOf(el, theme);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * One colour element.
 *
 * `srgbClr` and `sysClr` are read directly and `schemeClr` through the theme.
 * Anything else — `scrgbClr`, `hslClr`, `prstClr`, and the `phClr` placeholder
 * a style reference uses — resolves to nothing, because guessing a colour wrong
 * is more visible than leaving the schema's default in place.
 *
 * @param {Element} el
 * @param {Map<string, string>} theme
 * @returns {{color: string, opacity: number}|null}
 */
function colorOf(el, theme) {
  const tag = local(el);
  let color = '';
  if (tag === 'srgbClr') color = rgb(attr(el, 'val'));
  else if (tag === 'sysClr') color = rgb(attr(el, 'lastClr'));
  else if (tag === 'schemeClr') {
    const key = (attr(el, 'val') || '').toLowerCase();
    color = theme.get(SCHEME_ALIAS[/** @type {keyof typeof SCHEME_ALIAS} */ (key)] || key) || '';
  }
  if (!color) return null;
  return { color, opacity: attrNum(child(el, 'alpha'), 'val', PER_CENT) / PER_CENT };
}

/** `RRGGBB` → `#rrggbb`, or `''` for anything else. @param {string|null} val */
function rgb(val) {
  const hex = (val || '').trim().toLowerCase();
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : '';
}

/**
 * A `<a:solidFill>` inside `spPr`, `rPr` or `bgPr`.
 *
 * @param {Element|null} el
 * @param {Map<string, string>} theme
 * @returns {{color: string, opacity: number}|null}
 */
function solidFill(el, theme) {
  return readColor(child(el, 'solidFill'), theme);
}

/**
 * A `<a:gradFill>` as the slide background the schema has: a CSS angle and its
 * stops, or `null` when fewer than two stops resolve to a colour.
 *
 * The angle is a conversion, not a copy: OOXML measures clockwise from the
 * positive x-axis (`0` runs left to right), CSS from the upward vertical
 * (`180deg` runs top to bottom, which is `geometry.gradientLine`'s convention),
 * so the two differ by a quarter turn. A radial or path gradient has no angle at
 * all and is kept as a linear one, counted.
 *
 * @param {Element} grad
 * @param {PptxContext} ctx
 * @param {number} slide
 * @returns {{type: 'gradient', angle: number, stops: Array<{at: number, color: string}>}|null}
 */
function gradient(grad, ctx, slide) {
  const stops = [];
  for (const gs of children(child(grad, 'gsLst'), 'gs')) {
    const color = readColor(gs, ctx.theme);
    if (color) stops.push({ at: attrNum(gs, 'pos', 0) / PER_CENT, color: color.color });
  }
  if (stops.length < 2) return null;
  const lin = child(grad, 'lin');
  if (!lin) ctx.report.drop(slide, 'radial gradient (kept linear)');
  return { type: 'gradient', angle: attrNum(lin, 'ang', 0) / PER_DEGREE + 90, stops };
}

/**
 * `<a:srcRect>` — the part of an image the shape shows — as the slide `crop`
 * the schema has. Both are fractions of the source image; OOXML states insets
 * from each edge, the schema states the rectangle that survives them.
 *
 * @param {Element|null} srcRect
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function cropOf(srcRect) {
  if (!srcRect) return null;
  const x = attrNum(srcRect, 'l', 0) / PER_CENT;
  const y = attrNum(srcRect, 't', 0) / PER_CENT;
  const w = 1 - x - attrNum(srcRect, 'r', 0) / PER_CENT;
  const h = 1 - y - attrNum(srcRect, 'b', 0) / PER_CENT;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * A shape's rectangle in source EMU, or `null` when it does not state one.
 *
 * A shape with no `<a:xfrm>` is a placeholder inheriting its geometry from the
 * slide layout or master, and this importer deliberately does not walk that
 * chain: doing it properly means resolving layout, master and placeholder index
 * with the inheritance rules the spec gives them, and doing it improperly means
 * text landing somewhere the author never put it. It is counted instead.
 *
 * Rotation is read only to be reported. The schema's `box` has no rotation, so a
 * rotated shape imports square — which is visibly wrong in one specific way the
 * report can name, rather than invisibly wrong.
 *
 * @param {PptxContext} ctx
 * @param {Element} shape
 * @param {PptxPage} page
 * @param {string} what the shape's name for the report
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function rectOf(ctx, shape, page, what) {
  const xfrm = path(shape, 'spPr', 'xfrm') || path(shape, 'grpSpPr', 'xfrm');
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  if (!off || !ext) {
    ctx.report.drop(page.index, `${what} whose geometry comes from the slide layout`);
    return null;
  }
  if (attrNum(xfrm, 'rot', 0) !== 0) ctx.report.drop(page.index, 'rotation (imported unrotated)');
  if (attrBool(xfrm, 'flipH') || attrBool(xfrm, 'flipV')) {
    ctx.report.drop(page.index, 'flip (imported unflipped)');
  }
  return {
    x: attrNum(off, 'x', 0),
    y: attrNum(off, 'y', 0),
    w: Math.max(1, attrNum(ext, 'cx', 0)),
    h: Math.max(1, attrNum(ext, 'cy', 0)),
  };
}

/**
 * Does this rectangle cover the slide? A full-frame picture becomes the slide's
 * *own* source rather than an `image` layer, which is what makes the photo
 * replaceable when the template is applied to a post.
 *
 * @param {PptxContext} ctx
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @returns {boolean}
 */
function isFullFrame(ctx, rect) {
  return (
    rect.w >= ctx.srcW * FULL_FRAME.cover &&
    rect.h >= ctx.srcH * FULL_FRAME.cover &&
    rect.x <= ctx.srcW * FULL_FRAME.offset &&
    rect.y <= ctx.srcH * FULL_FRAME.offset
  );
}

/**
 * Add a layer, normalized. Returns whether it survived — a shape the schema
 * rejects is counted rather than repaired, because the alternative is this
 * module deciding what a layer may be, which is `document.js`'s job.
 *
 * @param {PptxContext} ctx
 * @param {PptxPage} page
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
 * One slide.
 *
 * @param {PptxContext} ctx
 * @param {string} part
 * @param {number} index
 * @returns {Promise<import('../document.js').CarouselSlide>}
 * @throws {ImportError} when this slide cannot be read — costing this slide only
 */
async function importSlide(ctx, part, index) {
  const sld = await readPart(ctx.zip, part, 'sld', ctx.parser);
  if (!sld) throw new ImportError('malformed', 'is not readable as a slide', part);
  const cSld = child(sld, 'cSld');
  const tree = path(cSld, 'spTree');
  if (!tree) throw new ImportError('malformed', 'has no shape tree', part);

  /** @type {PptxPage} */
  const page = {
    slide: { source: '', fit: 'cover', bg: null, layers: [] },
    index,
    rels: await readRels(ctx.zip, part, ctx.parser),
  };

  await readSlideBg(ctx, cSld, page);
  for (const node of children(tree)) {
    const tag = local(node);
    if (NOT_A_SHAPE.has(tag)) continue;
    ctx.shapes.total++;
    if (await importShape(ctx, tag, node, page)) ctx.shapes.kept++;
  }
  return page.slide;
}

/**
 * The slide's own background. `<p:bgRef>` — a fill inherited from the theme's
 * style matrix — is counted rather than resolved, for `rectOf`'s reason: the
 * inheritance chain is not somewhere to guess.
 *
 * @param {PptxContext} ctx
 * @param {Element|null} cSld
 * @param {PptxPage} page
 */
async function readSlideBg(ctx, cSld, page) {
  const bg = child(cSld, 'bg');
  if (!bg) return;
  if (child(bg, 'bgRef')) {
    ctx.report.drop(page.index, 'background inherited from the theme');
    return;
  }
  const bgPr = child(bg, 'bgPr');
  if (!bgPr) return;

  const fill = bgFill(ctx, bgPr, page.index);
  if (fill) {
    page.slide.bg = fill;
    return;
  }
  // An image background is the slide's *source*, not its `bg`: it is the pixels
  // a post's own photo replaces.
  const blip = path(bgPr, 'blipFill', 'blip');
  if (!blip) return;
  const url = await inlineBlip(ctx, blip, page);
  if (!url) return;
  page.slide.source = url;
  const crop = cropOf(path(bgPr, 'blipFill', 'srcRect'));
  if (crop) page.slide.crop = crop;
}

/**
 * A background's flat or gradient fill, or `null` when it has neither.
 *
 * @param {PptxContext} ctx
 * @param {Element} bgPr
 * @param {number} index
 * @returns {import('../document.js').CarouselBg|null}
 */
function bgFill(ctx, bgPr, index) {
  const solid = solidFill(bgPr, ctx.theme);
  if (solid) return { type: 'solid', color: solid.color };
  const grad = child(bgPr, 'gradFill');
  if (!grad) return null;
  const stops = gradient(grad, ctx, index);
  if (stops) return stops;
  ctx.report.drop(index, 'background gradient Point could not read');
  return null;
}

/**
 * One `<p:spTree>` child. Returns whether it produced anything — a layer, the
 * slide's picture or its background — which is what "kept 14 of 22 shapes"
 * counts.
 *
 * A group is dropped whole rather than flattened: its children carry their own
 * coordinate space through `<a:chOff>`/`<a:chExt>`, and mapping that correctly
 * is a second transform stack for a case a template rarely needs. The report
 * says so, and the author can ungroup in PowerPoint and re-export.
 *
 * @param {PptxContext} ctx
 * @param {string} tag
 * @param {Element} node
 * @param {PptxPage} page
 * @returns {Promise<boolean>}
 */
async function importShape(ctx, tag, node, page) {
  if (tag === 'sp') return importSp(ctx, node, page);
  if (tag === 'pic') return importPic(ctx, node, page);
  if (tag === 'grpSp') {
    ctx.report.drop(page.index, 'group (its shapes are not imported)');
    return false;
  }
  if (tag === 'graphicFrame') {
    const uri = attr(path(node, 'graphic', 'graphicData'), 'uri') || '';
    const kind = GRAPHIC_KINDS.find(([mark]) => uri.includes(mark));
    ctx.report.drop(page.index, kind ? kind[1] : 'graphic frame');
    return false;
  }
  ctx.report.drop(page.index, tag === 'cxnSp' ? 'connector' : `<p:${tag}>`);
  return false;
}

/**
 * A `<p:sp>`: a text box, a rectangle, or something the schema has no shape
 * for. Text wins when there is any — a filled box with a headline in it is a
 * text layer, and its fill is the design's business, not the schema's.
 *
 * @param {PptxContext} ctx
 * @param {Element} sp
 * @param {PptxPage} page
 * @returns {boolean}
 */
function importSp(ctx, sp, page) {
  const spPr = child(sp, 'spPr');
  if (children(child(spPr, 'effectLst')).length) {
    ctx.report.drop(page.index, 'shape effect (shadow, glow or reflection)');
  }
  const body = textOf(sp);
  const rect = rectOf(ctx, sp, page, body ? 'text' : 'shape');
  if (!rect) return false;
  const box = ctx.fit.box(rect.x, rect.y, rect.w, rect.h);
  if (body) {
    recordFonts(ctx, body.txBody);
    return addLayer(ctx, page, { type: 'text', box, ...textStyle(ctx, body, page.index) });
  }
  return shapeFill(ctx, spPr, { rect, box }, page);
}

/**
 * A shape with no text: the schema's `rect` layer, the slide's gradient
 * background, or a count.
 *
 * @param {PptxContext} ctx
 * @param {Element|null} spPr
 * @param {{rect: {x: number, y: number, w: number, h: number},
 *   box: import('../document.js').CarouselBox}} geom the shape's rectangle in
 *   source EMU, and the same rectangle fitted to the target canvas
 * @param {PptxPage} page
 * @returns {boolean}
 */
function shapeFill(ctx, spPr, geom, page) {
  const grad = child(spPr, 'gradFill');
  if (grad) return shapeGradient(ctx, grad, geom.rect, page);

  const prst = presetOf(spPr);
  if (!RECT_PRESETS.has(prst)) {
    ctx.report.drop(page.index, prst ? `${prst} shape` : 'shape with no geometry');
    return false;
  }
  const fill = solidFill(spPr, ctx.theme);
  if (!fill) {
    // A `rect` layer is a fill and nothing else: the schema has no stroke, so an
    // outlined-but-unfilled box has nothing left to import.
    const why = child(spPr, 'ln') ? 'outline-only shape' : 'shape with no readable fill';
    ctx.report.drop(page.index, why);
    return false;
  }
  return addLayer(ctx, page, {
    type: 'rect',
    box: geom.box,
    fill: fill.color,
    opacity: fill.opacity,
    radius: prst === 'roundRect' ? roundOf(path(spPr, 'prstGeom', 'avLst')) : 0,
  });
}

/**
 * A shape's geometry preset — `rect`, `ellipse`, `star5` — or `custom` for a
 * hand-drawn one, or `''` for a shape that states no geometry at all. Three
 * cases the report says three different things about.
 *
 * @param {Element|null} spPr
 * @returns {string}
 */
function presetOf(spPr) {
  const prst = attr(path(spPr, 'prstGeom'), 'prst');
  if (prst) return prst;
  return child(spPr, 'custGeom') ? 'custom' : '';
}

/**
 * A gradient-filled shape. One that covers the slide is the design's
 * background; one that does not has nowhere to go, because the `rect` layer is
 * a flat fill and inventing a middle colour for it would be a guess at the
 * design rather than a reading of it.
 *
 * @param {PptxContext} ctx
 * @param {Element} grad
 * @param {{x: number, y: number, w: number, h: number}} rect source EMU
 * @param {PptxPage} page
 * @returns {boolean}
 */
function shapeGradient(ctx, grad, rect, page) {
  const stops = isFullFrame(ctx, rect) && !page.slide.bg ? gradient(grad, ctx, page.index) : null;
  if (!stops) {
    ctx.report.drop(page.index, 'gradient fill on a shape');
    return false;
  }
  page.slide.bg = stops;
  return true;
}

/**
 * `roundRect`'s corner as the schema's `radius`: a fraction of the shorter
 * side, which is the same convention the preset's own adjust value uses — so
 * this is a scale, not a reinterpretation.
 *
 * @param {Element|null} avLst
 * @returns {number}
 */
function roundOf(avLst) {
  const gd = children(avLst, 'gd').find((el) => (attr(el, 'name') || '') === 'adj');
  const val = /^val\s+(-?\d+)$/.exec((attr(gd, 'fmla') || '').trim());
  return (val ? Number(val[1]) : DEFAULT_ROUND) / PER_CENT;
}

/**
 * A `<p:pic>`: the slide's own photograph when it covers the slide, an `image`
 * layer when it does not.
 *
 * @param {PptxContext} ctx
 * @param {Element} pic
 * @param {PptxPage} page
 * @returns {Promise<boolean>}
 */
async function importPic(ctx, pic, page) {
  const rect = rectOf(ctx, pic, page, 'picture');
  const blipFill = child(pic, 'blipFill');
  const blip = child(blipFill, 'blip');
  if (!rect || !blip) {
    if (rect) ctx.report.drop(page.index, 'picture with no embedded image');
    return false;
  }
  notePicture(ctx, pic, blip, page.index);
  const url = await inlineBlip(ctx, blip, page);
  if (!url) return false;

  const opacity = attrNum(child(blip, 'alphaModFix'), 'amt', PER_CENT) / PER_CENT;
  const crop = cropOf(child(blipFill, 'srcRect'));

  // The slide's own picture, and only the first one: a second full-frame photo
  // is a layer over it, which is what it looks like on the slide too.
  if (isFullFrame(ctx, rect) && !page.slide.source) {
    return asSlidePhoto(ctx, page, { url, crop, opacity });
  }
  if (crop) ctx.report.drop(page.index, 'image crop on a layer');
  return addLayer(ctx, page, {
    type: 'image',
    box: ctx.fit.box(rect.x, rect.y, rect.w, rect.h),
    source: url,
    fit: 'contain',
    opacity,
  });
}

/**
 * A full-frame picture as the slide's own source rather than as a layer. This
 * is the one mapping that makes an imported template *useful*: the slide's
 * source is what `applyTemplate` replaces with the post's photograph, so a
 * background picture has to land there and nowhere else.
 *
 * @param {PptxContext} ctx
 * @param {PptxPage} page
 * @param {{url: string, crop: {x: number, y: number, w: number, h: number}|null,
 *   opacity: number}} photo
 * @returns {true}
 */
function asSlidePhoto(ctx, page, photo) {
  page.slide.source = photo.url;
  page.slide.fit = 'cover';
  if (photo.crop) page.slide.crop = photo.crop;
  // A slide's pixels have no opacity in the schema — only a layer does.
  if (photo.opacity < 1) ctx.report.drop(page.index, 'image transparency on the slide photo');
  return true;
}

/**
 * What a picture had done to it that the schema cannot reproduce.
 *
 * @param {PptxContext} ctx
 * @param {Element} pic
 * @param {Element} blip
 * @param {number} index
 */
function notePicture(ctx, pic, blip, index) {
  if (children(child(child(pic, 'spPr'), 'effectLst')).length) {
    ctx.report.drop(index, 'shape effect (shadow, glow or reflection)');
  }
  if (child(blip, 'duotone') || child(blip, 'clrChange')) {
    ctx.report.drop(index, 'image recolouring');
  }
}

/**
 * The `data:` URL for a `<a:blip>`, or `''` when there is nothing to inline or
 * the budget refused it — which the report already names.
 *
 * @param {PptxContext} ctx
 * @param {Element} blip
 * @param {PptxPage} page
 * @returns {Promise<string>}
 */
async function inlineBlip(ctx, blip, page) {
  const rid = attr(blip, 'embed') || attr(blip, 'link') || '';
  const part = rid ? page.rels.get(rid) || '' : '';
  if (!part) {
    ctx.report.drop(page.index, 'image stored outside the file');
    return '';
  }
  if (!ctx.zip.has(part)) {
    ctx.report.drop(page.index, `image missing from the file: ${part.split('/').pop()}`);
    return '';
  }
  return ctx.assets.inline(part, await readBytes(ctx.zip, part), page.index);
}

/**
 * A shape's text, or `null` when it has none worth a layer.
 *
 * Paragraphs join with a newline and runs join with nothing, which is what the
 * markup means: a run boundary is a formatting change, not a word boundary.
 * Only the first run's formatting survives — the schema styles a layer, not a
 * span — so a headline with one italic word imports in the headline's style.
 *
 * @param {Element} sp
 * @returns {{text: string, txBody: Element, first: Element|null}|null}
 */
function textOf(sp) {
  const txBody = child(sp, 'txBody');
  if (!txBody) return null;
  const paras = children(txBody, 'p');
  const text = paras
    .map((p) => children(p).map(runText).join(''))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  if (!text) return null;
  const withRun = paras.find((p) => children(p, 'r').length);
  return { text, txBody, first: withRun || paras[0] || null };
}

/**
 * One child of a paragraph, as the text it contributes.
 *
 * `fld` is a field — a slide number or a date — and its `a:t` is the value
 * PowerPoint last computed. Literal text is the right import: a template that
 * renumbered itself would be a `counter` layer, which the author adds
 * deliberately.
 *
 * @param {Element} node
 * @returns {string}
 */
function runText(node) {
  const tag = local(node);
  if (tag === 'br') return '\n';
  const t = tag === 'r' || tag === 'fld' ? child(node, 't') : null;
  return t ? t.textContent || '' : '';
}

/**
 * The run properties a text layer's style comes from: the first run's, with the
 * paragraph's and the list style's defaults behind it — the same order
 * PowerPoint resolves them in, minus the layout and master this importer does
 * not walk.
 *
 * @param {Element} txBody
 * @param {Element|null} first the first paragraph carrying a run
 * @returns {Element|null}
 */
function runProps(txBody, first) {
  return (
    child(children(first, 'r')[0] || null, 'rPr') ||
    child(child(first, 'pPr'), 'defRPr') ||
    path(txBody, 'lstStyle', 'lvl1pPr', 'defRPr')
  );
}

/**
 * Type the schema can hold the words of but not the styling of.
 *
 * @param {PptxContext} ctx
 * @param {Element|null} rPr
 * @param {Element|null} bodyPr
 * @param {number} index
 */
function notePlainType(ctx, rPr, bodyPr, index) {
  if (attrBool(rPr, 'i') || (attr(rPr, 'u') || 'none') !== 'none') {
    ctx.report.drop(index, 'italic or underlined type (imported plain)');
  }
  if ((attr(bodyPr, 'vert') || 'horz') !== 'horz') {
    ctx.report.drop(index, 'vertical text (imported horizontal)');
  }
}

/**
 * The text layer's fields.
 *
 * `size` is a fraction of the *target* canvas height, converted through the
 * source canvas: a 40pt headline on a 7.5in slide is 7.4% of its height, and it
 * stays 7.4% of the height it is fitted into.
 *
 * @param {PptxContext} ctx
 * @param {{text: string, txBody: Element, first: Element|null}} body
 * @param {number} index
 * @returns {*}
 */
function textStyle(ctx, body, index) {
  const bodyPr = child(body.txBody, 'bodyPr');
  const pPr = child(body.first, 'pPr');
  const rPr = runProps(body.txBody, body.first);
  notePlainType(ctx, rPr, bodyPr, index);

  const sz = attrNum(rPr, 'sz', 0);
  const fill = solidFill(rPr, ctx.theme);
  return {
    text: body.text,
    // No size at all means "auto-fit the box", which is the schema's default and
    // a better answer than a size invented here.
    size: sz > 0 ? ctx.fit.height((sz / 100) * EMU_PER_POINT) : null,
    weight: attrBool(rPr, 'b') ? 700 : 400,
    // Unstated text colour is the theme's body colour, not the schema's white: a
    // deck's type is usually dark on a light design, and white would be
    // invisible exactly there.
    color: fill ? fill.color : ctx.theme.get('dk1') || undefined,
    ...paragraphStyle(pPr, bodyPr),
  };
}

/**
 * The layer style that comes from the paragraph and the body rather than from
 * the run — OOXML's own split, kept because it is also where the schema's
 * fields divide. `undefined` for anything unstated, which is how
 * `normalizeLayer` is told to use its default.
 *
 * @param {Element|null} pPr
 * @param {Element|null} bodyPr
 * @returns {{align: string|undefined, valign: string|undefined, lineHeight: number|undefined}}
 */
function paragraphStyle(pPr, bodyPr) {
  const algn = (attr(pPr, 'algn') || '').toLowerCase();
  const anchor = (attr(bodyPr, 'anchor') || '').toLowerCase();
  const spcPct = attrNum(path(pPr, 'lnSpc', 'spcPct'), 'val', 0);
  return {
    align: TEXT_ALIGN[/** @type {keyof typeof TEXT_ALIGN} */ (algn)] || undefined,
    valign: TEXT_ANCHOR[/** @type {keyof typeof TEXT_ANCHOR} */ (anchor)] || undefined,
    lineHeight: spcPct > 0 ? spcPct / PER_CENT : undefined,
  };
}

/**
 * Every typeface a text body names, into the report and nowhere else.
 *
 * @param {PptxContext} ctx
 * @param {Element} txBody
 */
function recordFonts(ctx, txBody) {
  // `latin`, `ea` and `cs` are the three script slots a run can name a face in.
  for (const slot of ['latin', 'ea', 'cs']) {
    for (const face of descendants(txBody, slot)) ctx.report.font(attr(face, 'typeface') || '');
  }
}
