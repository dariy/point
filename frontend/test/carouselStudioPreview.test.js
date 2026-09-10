/**
 * carousel/studio/preview.js — the live preview, written as CSS.
 *
 * These functions are the studio's only DOM writes for framing, and they hold
 * no state: they take the elements and the numbers. So the tests hand them
 * plain `{ style: {} }` stand-ins and read the properties back — which is also
 * what pins the two things the module exists to get right: the crop reproduced
 * as `background-size`/`background-position` (so the preview cannot lie about
 * the render), and the source path set from JS and URI-encoded, so a media
 * path with a quote in it cannot break out of the `url()`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  arrowPlan,
  paintAnchorRail,
  paintDeckLayers,
  paintDeckSlide,
  paintSpanChrome,
  paintSplit,
  textPlan,
} from '../src/plugins/carousel/studio/preview.js';
import { paintLayers } from '../src/plugins/carousel/render.js';
import { canvasSize, layerRect } from '../src/plugins/carousel/geometry.js';
import { normalizeLayer } from '../src/plugins/carousel/document.js';

/** Every glyph is half an em wide — the same law `carouselRender.test.js` gives
 *  its recording ctx, which is what lets the preview's typesetting and the
 *  render's be compared line for line. */
const CHAR_EM = 0.5;

/** The px size out of a CSS font shorthand (`600 42px "Inter", sans-serif`). */
function fontPx(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  return m ? Number(m[1]) : 0;
}

/** A `measure` in that same law, for driving `textPlan` directly. */
const measure = (text, size) => ({ width: text.length * CHAR_EM * size });

/** The stand-in face's vertical metrics, as fractions of the font size. The
 *  central baseline is deliberately NOT `(ascent - descent) / 2`, because in a
 *  real browser it is not either — that gap is the whole reason `preview.js`
 *  measures a baseline shift instead of assuming one. */
const ASCENT = 0.8;
const DESCENT = 0.2;
const CENTRAL = 0.25;
/** What that costs the block's top, per px of font size: `-central - (A-D)/2`. */
const SHIFT_PER_PX = CENTRAL - (ASCENT - DESCENT) / 2;

/** `preview.js` measures on an offscreen 2D context it takes from `document`
 *  and memoizes on first use; in node there is none, so it gets this. Assigned
 *  at module scope so it is in place before any test paints. */
globalThis.document = {
  createElement: () => {
    const ctx = {
      font: '',
      textBaseline: 'alphabetic',
      measureText: (text) => {
        const size = fontPx(ctx.font);
        return {
          width: String(text).length * CHAR_EM * size,
          fontBoundingBoxAscent: ASCENT * size,
          fontBoundingBoxDescent: DESCENT * size,
          alphabeticBaseline: ctx.textBaseline === 'middle' ? -CENTRAL * size : 0,
        };
      },
    };
    return { getContext: () => ctx };
  },
};

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const el = () => ({ style: {} });

describe('carousel studio preview', () => {
  describe('paintDeckSlide', () => {
    test('an untouched crop fills the frame at 100%', () => {
      const img = el();
      const bg = el();
      paintDeckSlide(
        { imgs: [img], bgs: [bg] },
        {
          slide: { source: 'test.jpg', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );

      assert.strictEqual(img.style.backgroundImage, 'url("test.jpg")');
      assert.strictEqual(img.style.backgroundSize, '100% 100%');
      assert.strictEqual(img.style.backgroundPosition, '0% 0%');
      assert.strictEqual(img.style.backgroundRepeat, 'no-repeat');
    });

    test('a half-width crop is a 200% background — the zoom the render will apply', () => {
      const img = el();
      paintDeckSlide(
        { imgs: [img], bgs: [el()] },
        {
          slide: {
            source: 'a.jpg',
            crop: { x: 0.5, y: 0, w: 0.5, h: 1 },
            fit: 'cover',
            bg: null,
          },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(img.style.backgroundSize, '200% 200%');
      assert.strictEqual(img.style.backgroundPosition, '100% 50%');
    });

    test('every element showing the slide is painted, stage slice and filmstrip frame alike', () => {
      const stageImg = el();
      const stripImg = el();
      paintDeckSlide(
        { imgs: [stageImg, stripImg], bgs: [] },
        {
          slide: { source: 'a.jpg', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(stageImg.style.backgroundImage, stripImg.style.backgroundImage);
      assert.strictEqual(stageImg.style.backgroundSize, stripImg.style.backgroundSize);
    });

    test('a source path is URI-encoded, so a quote cannot break out of the url()', () => {
      const img = el();
      paintDeckSlide(
        { imgs: [img], bgs: [] },
        {
          slide: { source: '/media/a"); evil.jpg', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(img.style.backgroundImage, 'url("/media/a%22);%20evil.jpg")');
    });

    test('a slide with no source paints no image at all', () => {
      const img = el();
      paintDeckSlide(
        { imgs: [img], bgs: [] },
        {
          slide: { source: '', crop: FULL, fit: 'cover', bg: null },
          srcW: 1000,
          srcH: 1000,
          aspect: '1:1',
          hasPad: false,
        },
      );
      assert.strictEqual(img.style.backgroundImage, 'none');
    });
  });

  describe('the fill layer behind a deck slide', () => {
    const paintBg = (slideBg, hasPad) => {
      const bg = el();
      paintDeckSlide(
        { imgs: [], bgs: [bg] },
        {
          slide: {
            source: 'a.jpg',
            crop: { x: 0, y: 0, w: 1, h: 0.5 },
            fit: 'contain',
            bg: slideBg,
          },
          srcW: 2000,
          srcH: 1000,
          aspect: '1:1',
          hasPad,
        },
      );
      return bg.style;
    };

    test('a slide with no letterbox keeps the layer empty, so the hatch shows through', () => {
      const style = paintBg({ type: 'solid', color: '#ff0000' }, false);
      assert.strictEqual(style.backgroundImage, 'none');
      assert.strictEqual(style.backgroundColor, 'transparent');
      assert.strictEqual(style.filter, 'none');
    });

    test('a solid fill is a background colour', () => {
      const style = paintBg({ type: 'solid', color: '#ff0000' }, true);
      assert.strictEqual(style.backgroundColor, '#ff0000');
      assert.strictEqual(style.backgroundImage, 'none');
    });

    test('a gradient is literal CSS, in the same angle convention the canvas uses', () => {
      const style = paintBg(
        {
          type: 'gradient',
          angle: 45,
          stops: [
            { at: 0, color: '#000000' },
            { at: 1, color: '#ffffff' },
          ],
        },
        true,
      );
      assert.strictEqual(
        style.backgroundImage,
        'linear-gradient(45deg, #000000 0%, #ffffff 100%)',
      );
      assert.strictEqual(style.backgroundColor, 'transparent');
    });

    test('blur is the slide\'s own image, reusing its numbers and blurred in cqw', () => {
      const style = paintBg(null, true);
      assert.strictEqual(style.backgroundImage, 'url("a.jpg")');
      assert.match(style.filter, /^blur\([\d.]+cqw\)$/);
      assert.ok(style.backgroundSize && style.backgroundSize !== '100% 100%');
    });
  });

  describe('paintSplit', () => {
    test('the stage and every frame carry the source over the pad hatch', () => {
      const stage = el();
      const frames = [el(), el()];
      paintSplit(
        { stage, frames },
        {
          source: 'split.jpg',
          srcW: 2000,
          srcH: 1000,
          aspect: '1:1',
          anchorY: 0.5,
          n: 2,
          strategy: 'cover',
        },
      );

      for (const target of [stage, ...frames]) {
        assert.match(target.style.backgroundImage, /^url\("split\.jpg"\), repeating-linear-gradient/);
        assert.strictEqual(target.style.backgroundRepeat, 'no-repeat, no-repeat');
        assert.match(target.style.backgroundSize, /^[\d.]+% [\d.]+%, 100% 100%$/);
      }
    });

    test('each frame shows its own slice — frame 2 is offset from frame 1', () => {
      const frames = [el(), el()];
      paintSplit(
        { stage: null, frames },
        {
          source: 'split.jpg',
          srcW: 2000,
          srcH: 1000,
          aspect: '1:1',
          anchorY: 0.5,
          n: 2,
          strategy: 'cover',
        },
      );
      assert.notStrictEqual(frames[0].style.backgroundPosition, frames[1].style.backgroundPosition);
    });

    test('a missing stage is not an error — the caller may render only a filmstrip', () => {
      const frames = [el()];
      assert.doesNotThrow(() =>
        paintSplit(
          { stage: null, frames },
          {
            source: 'a.jpg',
            srcW: 1000,
            srcH: 1000,
            aspect: '1:1',
            anchorY: 0.5,
            n: 1,
            strategy: 'cover',
          },
        ),
      );
      assert.match(frames[0].style.backgroundImage, /url\("a\.jpg"\)/);
    });

    test('before the probe resolves the stage falls back to its CSS default and the frames stretch', () => {
      const stage = el();
      const frames = [el(), el()];
      paintSplit(
        { stage, frames },
        {
          source: 'a.jpg',
          srcW: null,
          srcH: null,
          aspect: '1:1',
          anchorY: 0.5,
          n: 2,
          strategy: 'cover',
        },
      );
      assert.strictEqual(stage.style.backgroundImage, 'url("a.jpg")');
      assert.strictEqual(stage.style.backgroundSize, undefined, 'no crop to compute yet');
      assert.strictEqual(frames[0].style.backgroundSize, '200% 100%, 100% 100%');
      assert.strictEqual(frames[0].style.backgroundPosition, '0% 50%, 0% 0%');
      assert.strictEqual(frames[1].style.backgroundPosition, '100% 50%, 0% 0%');
    });
  });

  /**
   * The selection chrome of a *spanning* layer. Everything here is about one
   * thing: a layer whose box is fractions of the whole deck has to be drawn as
   * n slices that join, so the outline and the snap guides land where the seam
   * really is rather than n frames each guessing.
   */
  describe('paintSpanChrome', () => {
    /** The three elements `paintChrome` writes, plus the `createElement` the
     *  snap lines come from. `lines` collects whatever was appended. */
    function chromeHost() {
      const box = el();
      const lines = [];
      const snap = {
        appendChild: (n) => lines.push(n),
        set textContent(_v) {
          lines.length = 0;
        },
        get textContent() {
          return '';
        },
      };
      const chrome = {
        style: {},
        querySelector: (sel) =>
          sel === '.carousel-studio__chrome-box'
            ? box
            : sel === '.carousel-studio__snap'
              ? snap
              : null,
      };
      return {
        box,
        lines,
        chrome,
        ownerDocument: { createElement: () => ({ style: {}, className: '' }) },
        querySelector: (sel) => (sel === '.carousel-studio__chrome' ? chrome : null),
      };
    }

    const paint = (index, layer, guides = { v: [], h: [] }) => {
      const host = chromeHost();
      paintSpanChrome({ hosts: [host] }, { layer, aspect: '4:5', index, count: 3, guides });
      return host;
    };

    test('one slice per column, each continuing the last across the seam', () => {
      const layer = { box: { x: 0.3, y: 0.4, w: 0.6, h: 0.2 } };
      const lefts = [0, 1, 2].map((i) => parseFloat(paint(i, layer).box.style.left));
      // A one-slide offset in deck space is a full 100% of a column — which is
      // exactly what makes the outline continuous rather than merely close.
      assert.ok(Math.abs(lefts[0] - lefts[1] - 100) < 0.5, `${lefts}`);
      assert.ok(Math.abs(lefts[1] - lefts[2] - 100) < 0.5, `${lefts}`);
      // And every slice is the same width — the box is one rectangle, clipped.
      const widths = [0, 1, 2].map((i) => parseFloat(paint(i, layer).box.style.width));
      assert.ok(Math.abs(widths[0] - widths[2]) < 0.5, `${widths}`);
    });

    test('a column the layer misses is hidden, not emptied', () => {
      const host = paint(2, { box: { x: 0.02, y: 0.4, w: 0.2, h: 0.2 } });
      assert.strictEqual(host.chrome.style.display, 'none');
      const reached = paint(0, { box: { x: 0.02, y: 0.4, w: 0.2, h: 0.2 } });
      assert.strictEqual(reached.chrome.style.display, '');
    });

    test('a deck-space guide is re-based into the column it is drawn on', () => {
      const layer = { box: { x: 0.3, y: 0.4, w: 0.6, h: 0.2 } };
      // The seam at 2/3 of the deck is column 2's left edge and column 1's right.
      const at = (index) =>
        parseFloat(paint(index, layer, { v: [2 / 3], h: [] }).lines[0].style.left);
      assert.ok(Math.abs(at(2)) < 1e-6, `${at(2)}`);
      assert.ok(Math.abs(at(1) - 100) < 1e-6, `${at(1)}`);
    });

    test('a horizontal guide is the same line in either space', () => {
      const layer = { box: { x: 0.3, y: 0.4, w: 0.6, h: 0.2 } };
      const host = paint(1, layer, { v: [], h: [0.13] });
      assert.strictEqual(host.lines[0].style.top, '13%');
    });
  });
  describe('paintAnchorRail', () => {
    /** A rail stand-in: one custom-property sink and one readout node. */
    const rail = () => {
      const out = { textContent: '' };
      const props = {};
      return {
        out,
        props,
        style: { setProperty: (k, v) => (props[k] = v) },
        querySelector: () => out,
      };
    };

    test('the thumb sits where the band does, and says so', () => {
      const r = rail();
      paintAnchorRail(r, 0.25);
      assert.strictEqual(r.props['--carousel-anchor-pos'], '25%');
      assert.strictEqual(r.out.textContent, '25%');
    });

    test('an out-of-range anchor is pinned to the track rather than drawn off it', () => {
      const r = rail();
      paintAnchorRail(r, 1.4);
      assert.strictEqual(r.props['--carousel-anchor-pos'], '100%');
      assert.strictEqual(r.out.textContent, '100%');
    });

    test('no rail — a panorama with no slack — is not an error', () => {
      assert.doesNotThrow(() => paintAnchorRail(null, 0.5));
    });
  });

  /**
   * The bead this closes ("preview/render parity for text and arrows") turns on
   * one claim: the stage and the JPEG run the *same* typesetter. These tests
   * make that falsifiable — they paint the same layer twice, once through
   * `render.js` onto a recording ctx and once through `textPlan` / `arrowPlan`,
   * and assert the two agree exactly rather than approximately.
   */
  describe('parity with the render', () => {
    const ASPECT = '4:5';
    const [FRAME_W, FRAME_H] = canvasSize(ASPECT);

    /** The render's ctx, cut down to what a text or arrow layer touches. */
    function recordingCtx(log) {
      const ctx = {
        font: '',
        fillText: (text, x, y) => log.push(['fillText', text, x, y, ctx.font]),
        measureText: (text) => ({ width: text.length * CHAR_EM * fontPx(ctx.font) }),
        moveTo: (...a) => log.push(['moveTo', ...a]),
        lineTo: (...a) => log.push(['lineTo', ...a]),
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        stroke: () => {},
      };
      return ctx;
    }

    /** What `render.js` does with one layer on a fresh canvas. */
    function rendered(layer, env = {}) {
      const log = [];
      paintLayers(recordingCtx(log), [layer], ASPECT, env);
      return log;
    }

    const textLayer = (patch) =>
      normalizeLayer({
        type: 'text',
        text: 'The quick brown fox jumps over the lazy dog',
        box: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 },
        align: 'left',
        valign: 'top',
        ...patch,
      });

    /** Assert the preview's plan reproduces every `fillText` the render issued:
     *  the same lines, at the same size, on the same baselines. */
    function assertTypeParity(layer, env = {}) {
      const rect = layerRect(layer, ASPECT);
      const text =
        layer.type === 'counter'
          ? String(layer.format)
              .replace(/\{i\}/g, String((env.index || 0) + 1))
              .replace(/\{n\}/g, String(env.count || 1))
          : layer.text;
      const plan = textPlan({ text, layer, box: rect, frameH: FRAME_H, measure });
      const painted = rendered(layer, env).filter((e) => e[0] === 'fillText');

      assert.deepStrictEqual(
        painted.map((e) => e[1]),
        plan.lines,
        'the preview breaks lines where the render breaks them',
      );
      for (const e of painted) {
        assert.strictEqual(fontPx(e[4]), plan.fontSize, 'same type size');
      }
      painted.forEach((e, i) => {
        assert.strictEqual(
          e[3],
          rect.y + plan.top + (i + 0.5) * plan.lineBox,
          `line ${i} sits on the render's baseline`,
        );
      });
      return plan;
    }

    test('an auto-fit layer wraps and fits exactly as the render does', () => {
      const plan = assertTypeParity(textLayer({ size: null }));
      assert.ok(plan.lines.length >= 3, 'the fixture is long enough to wrap');
    });

    test('a fixed size wraps to the same lines on the same baselines', () => {
      assertTypeParity(textLayer({ size: 0.06 }));
    });

    test('valign moves the block by the render’s slack, not by flexbox', () => {
      for (const valign of ['top', 'middle', 'bottom']) {
        assertTypeParity(textLayer({ size: 0.06, valign }));
      }
    });

    test('a fixed size too big for its box overflows the way the render does', () => {
      // Negative slack: `middle` centres the overflow rather than pinning it,
      // which is the case a flex `align-items: center` used to get wrong.
      const layer = textLayer({ size: 0.2, valign: 'middle' });
      const plan = assertTypeParity(layer);
      assert.ok(plan.top < 0, 'the fixture really does overflow its box');
    });

    test('a counter is typeset through the same path, format substituted', () => {
      const layer = normalizeLayer({
        type: 'counter',
        format: '{i} / {n}',
        box: { x: 0.6, y: 0.85, w: 0.3, h: 0.1 },
        size: 0.05,
        align: 'right',
      });
      assertTypeParity(layer, { index: 2, count: 8 });
    });

    test('an arrow is the render’s polyline, in the box’s own pixels', () => {
      const layer = normalizeLayer({
        type: 'arrow',
        direction: 'right',
        box: { x: 0.7, y: 0.4, w: 0.2, h: 0.2 },
      });
      const rect = layerRect(layer, ASPECT);
      const plan = arrowPlan(rect, layer.direction);
      const path = rendered(layer)
        .filter((e) => e[0] === 'moveTo' || e[0] === 'lineTo')
        .map((e) => [e[1], e[2]]);

      assert.deepStrictEqual(
        plan.points.map(([x, y]) => [x + rect.x, y + rect.y]),
        path,
        'the same three points, once the box origin is added back',
      );
    });

    test('a left arrow points the other way, in both', () => {
      const layer = normalizeLayer({
        type: 'arrow',
        direction: 'left',
        box: { x: 0.05, y: 0.4, w: 0.2, h: 0.2 },
      });
      const rect = layerRect(layer, ASPECT);
      const plan = arrowPlan(rect, layer.direction);
      const path = rendered(layer)
        .filter((e) => e[0] === 'moveTo' || e[0] === 'lineTo')
        .map((e) => [e[1], e[2]]);
      assert.deepStrictEqual(
        plan.points.map(([x, y]) => [x + rect.x, y + rect.y]),
        path,
      );
      assert.ok(plan.points[1][0] < plan.points[0][0], 'the tip is on the left');
    });

    test('a box too small to hold its own stroke is skipped in both', () => {
      const layer = normalizeLayer({
        type: 'arrow',
        direction: 'right',
        box: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 },
      });
      const rect = layerRect(layer, ASPECT);
      assert.strictEqual(arrowPlan(rect, layer.direction), null);
      assert.deepStrictEqual(
        rendered(layer).filter((e) => e[0] === 'lineTo'),
        [],
      );
    });

    test('blank text sets nothing, exactly as the render paints nothing', () => {
      const layer = textLayer({ text: '   ', size: 0.06 });
      const rect = layerRect(layer, ASPECT);
      assert.strictEqual(
        textPlan({ text: layer.text, layer, box: rect, frameH: FRAME_H, measure }),
        null,
      );
      assert.deepStrictEqual(
        rendered(layer).filter((e) => e[0] === 'fillText'),
        [],
      );
    });
  });

  /**
   * The DOM half: what `paintDeckLayers` actually writes. The plan is already
   * pinned against the render above, so these assert only that the element
   * carries it — lines the browser cannot re-break, a line box in the painter's
   * arithmetic rather than CSS `line-height`, and a real polyline where the
   * preview used to show a `>` glyph.
   */
  describe('paintDeckLayers', () => {
    const ASPECT = '4:5';
    const [FRAME_W, FRAME_H] = canvasSize(ASPECT);
    const HEIGHT_CQW = (FRAME_H / FRAME_W) * 100;
    const cqw = (px) => `${((px / FRAME_H) * HEIGHT_CQW).toFixed(3)}cqw`;

    /** A stand-in document node: enough of one to build a span and an `<svg>`. */
    const stubDoc = {
      createElement: (tag) => node(tag, null),
      createElementNS: (ns, tag) => node(tag, ns),
    };

    function node(tag, ns) {
      return {
        tag,
        ns,
        style: {},
        attrs: {},
        children: [],
        textContent: '',
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
    }

    /** One `.carousel-studio__layer` element and the host that queries for it. */
    function host(count = 1) {
      const nodes = Array.from({ length: count }, (_, i) => {
        const el = node('div', null);
        el.dataset = { layer: String(i) };
        el.ownerDocument = stubDoc;
        Object.defineProperty(el, 'textContent', {
          get() {
            return '';
          },
          set(v) {
            if (v === '') this.children.length = 0;
          },
        });
        return el;
      });
      return { els: nodes, host: { querySelectorAll: () => nodes } };
    }

    function paintOne(layer, { index = 0, count = 1 } = {}) {
      const { els, host: h } = host(1);
      paintDeckLayers({ hosts: [h] }, { layers: [layer], aspect: ASPECT, index, count });
      return els[0];
    }

    test('text is emitted as resolved lines the browser cannot re-wrap', () => {
      const layer = normalizeLayer({
        type: 'text',
        text: 'The quick brown fox jumps over the lazy dog',
        box: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 },
        size: null,
        align: 'center',
        valign: 'top',
      });
      const plan = textPlan({
        text: layer.text,
        layer,
        box: layerRect(layer, ASPECT),
        frameH: FRAME_H,
        measure,
      });

      const el = paintOne(layer);
      assert.strictEqual(el.children.length, 1);
      const block = el.children[0];
      assert.strictEqual(block.textContent, plan.lines.join('\n'));
      assert.strictEqual(block.style.whiteSpace, 'pre');
      assert.strictEqual(block.style.fontSize, cqw(plan.fontSize));
      // The painter's line box, not CSS `line-height: 1.2` — that is what puts
      // every baseline where `fillText` puts it.
      assert.strictEqual(block.style.lineHeight, cqw(plan.lineBox));
      assert.strictEqual(block.style.top, cqw(plan.top + SHIFT_PER_PX * plan.fontSize));
      assert.strictEqual(block.style.textAlign, 'center');
    });

    test('the block is positioned, not flex-aligned — bottom moves it down', () => {
      const base = {
        type: 'text',
        text: 'one two three',
        box: { x: 0.1, y: 0.1, w: 0.8, h: 0.4 },
        size: 0.05,
      };
      const top = paintOne(normalizeLayer({ ...base, valign: 'top' })).children[0];
      const bottom = paintOne(normalizeLayer({ ...base, valign: 'bottom' })).children[0];
      // `top` valign is zero slack, so the block sits at the box's own top —
      // give or take the baseline shift, which is a property of the face.
      const fontSize = Math.round(0.05 * FRAME_H);
      assert.strictEqual(top.style.top, cqw(SHIFT_PER_PX * fontSize));
      assert.ok(parseFloat(bottom.style.top) > parseFloat(top.style.top));
      for (const block of [top, bottom]) {
        assert.strictEqual(block.style.justifyContent, undefined);
        assert.strictEqual(block.style.alignItems, undefined);
      }
    });

    test('an arrow is an inline SVG polyline over the layer box, not a glyph', () => {
      const layer = normalizeLayer({
        type: 'arrow',
        direction: 'right',
        box: { x: 0.7, y: 0.4, w: 0.2, h: 0.2 },
        color: '#ff0000',
      });
      const rect = layerRect(layer, ASPECT);
      const plan = arrowPlan(rect, layer.direction);

      const el = paintOne(layer);
      const svg = el.children[0];
      assert.strictEqual(svg.tag, 'svg');
      assert.strictEqual(svg.attrs.viewBox, `0 0 ${rect.w} ${rect.h}`);
      const poly = svg.children[0];
      assert.strictEqual(poly.tag, 'polyline');
      assert.strictEqual(
        poly.attrs.points,
        plan.points.map(([x, y]) => `${x},${y}`).join(' '),
      );
      assert.strictEqual(poly.attrs['stroke-width'], String(plan.stroke));
      assert.strictEqual(poly.attrs['stroke-linecap'], 'round');
      assert.strictEqual(poly.attrs['stroke-linejoin'], 'round');
      assert.strictEqual(poly.attrs.stroke, '#ff0000');
      assert.strictEqual(poly.attrs.fill, 'none');
    });

    test('an arrow too small for its stroke draws nothing at all', () => {
      const el = paintOne(
        normalizeLayer({
          type: 'arrow',
          direction: 'right',
          box: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 },
        }),
      );
      assert.deepStrictEqual(el.children, []);
    });

    test('a layer deleted since the last render hides its element', () => {
      const { els, host: h } = host(2);
      paintDeckLayers(
        { hosts: [h] },
        {
          layers: [normalizeLayer({ type: 'rect', box: { x: 0, y: 0, w: 1, h: 1 } })],
          aspect: ASPECT,
          index: 0,
          count: 1,
        },
      );
      assert.strictEqual(els[0].style.display, '');
      assert.strictEqual(els[1].style.display, 'none');
    });
  });
});
