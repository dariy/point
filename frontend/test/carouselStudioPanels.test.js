/**
 * carousel/studio/panels.js — the studio's markup builders.
 *
 * These functions are pure by design: they take the numbers the page reads off
 * its state and return `html`, answering no questions about the page itself.
 * That is what these tests pin — the branches each panel takes (a control that
 * would drive nothing is not rendered at all) and the `data-action` names the
 * page's delegated handlers key on, since a renamed action fails silently.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  actionsBar,
  bgControl,
  builder,
  colorInputValue,
  deckPanel,
  fitPanel,
  layerPanel,
  modeToggle,
  pickPrompt,
} from '../src/plugins/carousel/studio/panels.js';
import {
  emptyDocument,
  normalizeLayer,
  splitDocument,
  toDeckDocument,
} from '../src/plugins/carousel/document.js';

const doc3 = splitDocument({ source: '/m/x.jpg', n: 3, aspect: '4:5', strategy: 'cover' });

/** `html` returns a template object; every assertion here reads the string. */
const str = (v) => String(v);

describe('carousel studio panels', () => {
  describe('colorInputValue', () => {
    test('expands shorthand hex, since a colour input only accepts six digits', () => {
      assert.strictEqual(colorInputValue('#abc'), '#aabbcc');
      assert.strictEqual(colorInputValue('#ABC'), '#aabbcc');
    });

    test('drops the alpha channel from an 8-digit hex', () => {
      assert.strictEqual(colorInputValue('#11223344'), '#112233');
    });

    test('passes a 6-digit hex through, lowercased', () => {
      assert.strictEqual(colorInputValue('#ffffff'), '#ffffff');
      assert.strictEqual(colorInputValue('#ABCDEF'), '#abcdef');
    });

    test('falls back to black on anything a colour input would reject', () => {
      assert.strictEqual(colorInputValue(null), '#000000');
      assert.strictEqual(colorInputValue(undefined), '#000000');
      assert.strictEqual(colorInputValue(''), '#000000');
      assert.strictEqual(colorInputValue('red'), '#000000');
      assert.strictEqual(colorInputValue('#12345'), '#000000');
    });
  });

  describe('pickPrompt', () => {
    test('asks for a source', () => {
      assert.match(str(pickPrompt()), /Pick one image to slice/);
    });
  });

  describe('actionsBar', () => {
    test('a clean carousel offers Render and Remove, and claims nothing unsaved', () => {
      const out = str(
        actionsBar({
          busy: false,
          renderProgress: null,
          hasCarousel: true,
          dirty: false,
          hasSource: true,
        }),
      );
      assert.match(out, /data-action="render"/);
      assert.match(out, /data-action="remove-carousel"/);
      assert.doesNotMatch(out, /Unsaved — press Render/);
      assert.doesNotMatch(out, /carousel-studio__render-btn--dirty/);
    });

    test('a dirty document marks the render button and says so', () => {
      const out = str(
        actionsBar({
          busy: false,
          renderProgress: null,
          hasCarousel: true,
          dirty: true,
          hasSource: true,
        }),
      );
      assert.match(out, /carousel-studio__render-btn--dirty/);
      assert.match(out, /Unsaved — press Render/);
    });

    test('a document that was never rendered offers no Remove', () => {
      const out = str(
        actionsBar({
          busy: false,
          renderProgress: null,
          hasCarousel: false,
          dirty: false,
          hasSource: true,
        }),
      );
      assert.doesNotMatch(out, /data-action="remove-carousel"/);
    });

    test('a render in flight reports its progress and disables the button', () => {
      const out = str(
        actionsBar({
          busy: true,
          renderProgress: { done: 2, total: 5 },
          hasCarousel: false,
          dirty: true,
          hasSource: true,
        }),
      );
      assert.match(out, /disabled/);
      assert.match(out, /2/);
      assert.match(out, /5/);
    });
  });

  describe('modeToggle', () => {
    test('both modes are offered, with the current one pressed', () => {
      const out = str(modeToggle({ mode: 'split', canDeck: true, busy: false }));
      assert.match(out, /data-mode="split"/);
      assert.match(out, /data-mode="deck"/);
      assert.match(out, /aria-pressed="true"[^>]*>\s*Split/m);
      assert.match(out, /aria-pressed="false"[^>]*>\s*Deck/m);
    });

    test('deck is disabled until the source pixels are known', () => {
      const out = str(modeToggle({ mode: 'split', canDeck: false, busy: false }));
      assert.match(out, /data-mode="deck"[^>]*disabled|disabled[^>]*data-mode="deck"/s);
    });
  });

  describe('deckPanel', () => {
    test('an index that names no slide renders nothing at all', () => {
      assert.strictEqual(deckPanel({ doc: emptyDocument(), index: 0, hasPad: false }), '');
      assert.strictEqual(deckPanel({ doc: doc3, index: 9, hasPad: false }), '');
    });

    test('the readout names the slide, its crop and its zoom', () => {
      const doc = {
        ...doc3,
        slides: doc3.slides.map((s, i) =>
          i === 1 ? { ...s, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, fit: 'cover' } : s,
        ),
      };
      const out = str(deckPanel({ doc, index: 1, hasPad: false }));
      assert.match(out, /Slide 2 of 3/);
      assert.match(out, /50% × 50% of the source/);
      assert.match(out, /200% zoom/);
      assert.match(out, /filling the frame/);
    });

    test('a contain slide reads as letterboxed', () => {
      const doc = {
        ...doc3,
        slides: doc3.slides.map((s, i) => (i === 0 ? { ...s, fit: 'contain' } : s)),
      };
      assert.match(str(deckPanel({ doc, index: 0, hasPad: false })), /letterboxed/);
    });

    test('the fit chips and reset carry the slide index the page dispatches on', () => {
      const out = str(deckPanel({ doc: doc3, index: 2, hasPad: false }));
      assert.match(out, /data-action="slide-fit"[^>]*data-slide="2"/s);
      assert.match(out, /data-action="reset-slide"[^>]*data-slide="2"/s);
    });

    test('the letterbox fill appears only when the slide really has one', () => {
      assert.doesNotMatch(str(deckPanel({ doc: doc3, index: 0, hasPad: false })), /Letterbox fill/);
      assert.match(str(deckPanel({ doc: doc3, index: 0, hasPad: true })), /Letterbox fill/);
    });
  });

  describe('bgControl', () => {
    test('a slide with no fill defaults to blur, and offers no colour fields', () => {
      const out = str(bgControl({ index: 0, slide: { ...doc3.slides[0], bg: null } }));
      assert.match(out, /data-action="slide-bg"[^>]*data-bg="blur"[^>]*aria-pressed="true"/s);
      assert.doesNotMatch(out, /id="carousel-bg-color"/);
      assert.doesNotMatch(out, /id="carousel-bg-angle"/);
    });

    test('a solid fill adds its colour input, normalized for the control', () => {
      const slide = { ...doc3.slides[0], bg: { type: 'solid', color: '#abc' } };
      const out = str(bgControl({ index: 0, slide }));
      assert.match(out, /id="carousel-bg-color"[^>]*value="#aabbcc"/s);
      assert.doesNotMatch(out, /id="carousel-bg-from"/);
    });

    test('a gradient adds both ends and the angle, not a single colour', () => {
      const slide = {
        ...doc3.slides[0],
        bg: {
          type: 'gradient',
          angle: 45,
          stops: [
            { at: 0, color: '#000000' },
            { at: 1, color: '#ffffff' },
          ],
        },
      };
      const out = str(bgControl({ index: 0, slide }));
      assert.match(out, /id="carousel-bg-from"[^>]*value="#000000"/s);
      assert.match(out, /id="carousel-bg-to"[^>]*value="#ffffff"/s);
      assert.match(out, /id="carousel-bg-angle"[^>]*value="45"/s);
      assert.doesNotMatch(out, /id="carousel-bg-color"/);
    });
  });

  describe('fitPanel', () => {
    test('renders nothing until the source pixel size is known', () => {
      assert.strictEqual(fitPanel({ doc: doc3, srcW: null, srcH: null, fitMode: 'cover' }), '');
      assert.strictEqual(fitPanel({ doc: doc3, srcW: 3000, srcH: null, fitMode: 'cover' }), '');
    });

    test('reports the source and slide dimensions once they are known', () => {
      const out = str(fitPanel({ doc: doc3, srcW: 3000, srcH: 1000, fitMode: 'cover' }));
      assert.match(out, /Source 3000 × 1000/);
      assert.match(out, /3 slides/);
    });
  });

  describe('builder', () => {
  const builderProps = {
    doc: doc3,
    showGuides: true,
    selected: 0,
    deckIndex: 0,
    srcW: 3000,
    srcH: 1000,
    busy: false,
    fitMode: 'cover',
    hasPad: false,
    renderedPaths: [],
  };

    test('assembles the studio from the state the page hands it, and reads none of its own', () => {
      const out = str(builder(builderProps));
      assert.match(out, /id="carousel-aspect"/);
      assert.match(out, /id="carousel-guides"/);
      assert.match(out, /data-action="pick-source"/);
      assert.match(out, /carousel-studio__stage/);
      assert.match(out, /carousel-studio__filmstrip/);
    });

    test('split mode offers the count slider over the studio range', () => {
      const out = str(builder(builderProps));
      assert.match(out, /id="carousel-n"[\s\S]*?min="2"[\s\S]*?max="20"/);
    });

    test('deck mode drops the count slider — a deck slide count is not a slider', () => {
      const deck = { ...doc3, mode: 'deck' };
      const out = str(builder({ ...builderProps, doc: deck }));
      assert.doesNotMatch(out, /id="carousel-n"/);
    });

    test('the safe-area guides are drawn only when asked for', () => {
      assert.match(str(builder(builderProps)), /carousel-studio__safe/);
      assert.doesNotMatch(
        str(builder({ ...builderProps, showGuides: false })),
        /carousel-studio__safe/,
      );
    });

    test('the stage sits in its own scroller, and the zoom lands as one custom property', () => {
      // The stage is sized from a height budget and overflows sideways; a
      // stage that is not inside the scroller is the 22rem sliver again.
      const out = str(builder({ ...builderProps, stageZoom: 1.5 }));
      assert.match(out, /carousel-studio__stage-scroll[\s\S]*?carousel-studio__stage /);
      assert.match(out, /--carousel-stage-zoom:1\.5/);
      assert.match(out, /id="carousel-zoom-readout"[^>]*>150%/);
      assert.match(out, /data-action="stage-zoom"[\s\S]*?data-zoom="fit"/);
      assert.match(out, /data-action="stage-zoom"[\s\S]*?data-zoom="reset"/);
    });

    test('the mode’s panel is the properties panel, with the toggle reporting its state', () => {
      const open = str(builder({ ...builderProps, propsOpen: true }));
      assert.match(open, /class="carousel-studio__builder is-details-open"/);
      assert.match(open, /id="carousel-props"[\s\S]*?aria-hidden="false"/);
      assert.match(open, /aria-expanded="true"[\s\S]*?Hide properties/);
      // The fit panel — split mode's own panel — is inside the aside, not loose
      // in the column: the sheet is what has to carry it on a phone.
      assert.match(open, /<aside[\s\S]*?carousel-studio__fit[\s\S]*?<\/aside>/);

      const shut = str(builder({ ...builderProps, propsOpen: false }));
      assert.doesNotMatch(shut, /is-details-open/);
      assert.match(shut, /id="carousel-props"[\s\S]*?aria-hidden="true"/);
      assert.match(shut, /aria-expanded="false"[\s\S]*?>\s*Properties/);
    });

    test('the sheet ships its own backdrop and close, the way the post editor’s does', () => {
      const out = str(builder(builderProps));
      assert.match(out, /carousel-studio__props-backdrop"[\s\S]*?data-action="close-props"/);
      assert.match(out, /carousel-studio__props-close[\s\S]*?data-action="close-props"/);
    });

    test('deck mode puts the layer panel in the sheet too', () => {
      const deck = toDeckDocument(doc3, 3000, 1000);
      const out = str(builder({ ...builderProps, doc: deck, deckIndex: 0 }));
      assert.match(out, /<aside[\s\S]*?carousel-studio__layers[\s\S]*?<\/aside>/);
    });

    test('deck mode emits a span-layer node per frame for each span layer', () => {
      const deck = {
        ...toDeckDocument(doc3, 3000, 1000),
        spanLayers: [normalizeLayer({ type: 'text', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 }, text: 'H' })],
      };
      const out = str(builder({ ...builderProps, doc: deck, deckIndex: 0 }));
      const nodes = out.match(/carousel-studio__span-layer" data-span-layer="0"/g) || [];
      // one per stage slice and one per filmstrip frame — 3 slides → 6.
      assert.strictEqual(nodes.length, 6);
    });
  });

  describe('layerPanel — span layers', () => {
    const deck = toDeckDocument(doc3, 3000, 1000);
    const spanText = normalizeLayer({
      type: 'text',
      box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 },
      text: 'Big idea',
    });

    test('renders a deck-layer list alongside the slide list, span-scoped', () => {
      const out = str(layerPanel({ doc: { ...deck, spanLayers: [spanText] }, index: 0, selectedLayer: null, layerScope: 'slide', logoUrl: '' }));
      assert.match(out, /Slide 1 layers/);
      assert.match(out, /Deck layers/);
      // every add / select / reorder / delete in the span section carries the scope.
      assert.match(out, /data-action="add-layer"[\s\S]*?data-scope="span"/);
      assert.match(out, /data-action="select-layer"\s+data-scope="span"\s+data-index="0"/);
      assert.match(out, /data-action="delete-layer"\s+data-scope="span"/);
    });

    test('a span row is labelled with the slides it spans', () => {
      const out = str(layerPanel({ doc: { ...deck, spanLayers: [spanText] }, index: 0, selectedLayer: null, layerScope: 'slide', logoUrl: '' }));
      assert.match(out, /slides 1–3/);
    });

    test('the property form follows the active scope', () => {
      const spanSel = str(layerPanel({ doc: { ...deck, spanLayers: [spanText] }, index: 0, selectedLayer: 0, layerScope: 'span', logoUrl: '' }));
      // span layer 0 selected → its text form is shown.
      assert.match(spanSel, /carousel-studio__layer-form[\s\S]*?carousel-layer-text/);
      // the same index in slide scope names no slide layer → no form.
      assert.doesNotMatch(
        str(layerPanel({ doc: { ...deck, spanLayers: [spanText] }, index: 0, selectedLayer: 0, layerScope: 'slide', logoUrl: '' })),
        /carousel-studio__layer-form/,
      );
    });

    test('no span layers still offers the add chips and an explainer', () => {
      const out = str(layerPanel({ doc: deck, index: 0, selectedLayer: null, layerScope: 'slide', logoUrl: '' }));
      assert.match(out, /data-action="add-layer"[\s\S]*?data-scope="span"/);
      assert.match(out, /runs across the seams/);
    });
  });
});
