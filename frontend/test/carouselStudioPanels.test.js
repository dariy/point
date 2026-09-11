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
  anchorRail,
  bgControl,
  builder,
  colorInputValue,
  deckPanel,
  fitPanel,
  importDialog,
  importReportPanel,
  layerPanel,
  modeToggle,
  pickPrompt,
  saveTemplateDialog,
  templateGallery,
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

    /** The one button tag carrying `data-action="<name>"`, up to its `>`. The
     *  disabled state is per-button, so a whole-document regex would happily
     *  read the *other* button's attribute. */
    function buttonTag(out, name) {
      const marker = `data-action="${name}"`;
      const at = out.indexOf(marker);
      assert.notStrictEqual(at, -1, `no ${name} button`);
      return out.slice(out.lastIndexOf('<', at), out.indexOf('>', at));
    }

    test('undo and redo are offered, each disabled until the ring can serve it', () => {
      const base = {
        busy: false,
        renderProgress: null,
        hasCarousel: true,
        dirty: false,
        hasSource: true,
      };
      const undoable = str(actionsBar({ ...base, canUndo: true, canRedo: false }));
      assert.ok(!buttonTag(undoable, 'undo').includes('disabled'), 'undo is live');
      assert.ok(buttonTag(undoable, 'redo').includes('disabled'), 'nothing to redo');

      const both = str(actionsBar({ ...base, canUndo: true, canRedo: true }));
      assert.ok(!buttonTag(both, 'undo').includes('disabled'));
      assert.ok(!buttonTag(both, 'redo').includes('disabled'));

      const fresh = str(actionsBar(base));
      assert.ok(buttonTag(fresh, 'undo').includes('disabled'), 'nothing to undo by default');
      assert.ok(buttonTag(fresh, 'redo').includes('disabled'));
    });

    test('a render in flight takes undo and redo with it', () => {
      // The document the render is uploading from must not move under it.
      const out = str(
        actionsBar({
          busy: true,
          renderProgress: { done: 1, total: 3 },
          hasCarousel: true,
          dirty: true,
          hasSource: true,
          canUndo: true,
          canRedo: true,
        }),
      );
      assert.ok(buttonTag(out, 'undo').includes('disabled'));
      assert.ok(buttonTag(out, 'redo').includes('disabled'));
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
      assert.match(out, /aria-pressed="true"[^>]*>\s*Panorama/m);
      assert.match(out, /aria-pressed="false"[^>]*>\s*Slides/m);
    });

    test('the chips are named for what the modes do, not for the stored value', () => {
      const out = str(modeToggle({ mode: 'deck', canDeck: true, busy: false }));
      assert.doesNotMatch(out, />\s*Split\s*</);
      assert.doesNotMatch(out, />\s*Deck\s*</);
      // The stored vocabulary is untouched — `MODES` never changed.
      assert.match(out, /data-mode="split"/);
      assert.match(out, /data-mode="deck"/);
    });

    test('the hint says what switching away from Slides costs', () => {
      const out = str(modeToggle({ mode: 'deck', canDeck: true, busy: false }));
      // The interpolation escapes the apostrophe, so match around it.
      assert.match(out, /Panorama keeps only the first slide.{0,6}s photo/);
      assert.match(out, /discards the framing/);
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

    test('the photo button carries the slide index the page dispatches on', () => {
      const out = str(deckPanel({ doc: doc3, index: 2, hasPad: false }));
      assert.match(out, /data-action="pick-source"[^>]*data-slide="2"/s);
      // `data-slice` would make the button a host the deck painters draw
      // layer nodes into (see `_paintDeckSlideLayers`).
      assert.doesNotMatch(out, /data-action="pick-source"[^>]*data-slice=/s);
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

    test('the anchor slider names the stage as the direct way to the same field', () => {
      // 3240 × 2000 into a 3-slide 4:5 deck is pixel-exact across and leaves
      // 650 source px of vertical slack — so the control appears.
      const out = str(fitPanel({ doc: doc3, srcW: 3240, srcH: 2000, fitMode: 'cover' }));
      assert.match(out, /id="carousel-anchor"/, 'the assistive path is still there');
      assert.match(out, /drag the band up and down on the stage/i);
    });
  });

  describe('anchorRail', () => {
    test('a crop with vertical slack gets a rail, placed at the document anchor', () => {
      const out = str(anchorRail({ doc: doc3, srcW: 3240, srcH: 2000 }));
      assert.match(out, /carousel-studio__anchor-rail/);
      assert.match(out, /--carousel-anchor-pos:50%/, 'the default anchor is centred');
      assert.match(out, /50%<\/output>/);
      assert.match(out, /aria-hidden="true"/, 'the slider is the announced copy');
    });

    test('a crop that fills the height leaves nothing to drag, so no rail', () => {
      assert.strictEqual(anchorRail({ doc: doc3, srcW: 3240, srcH: 1350 }), '');
    });

    test('no rail before the source pixel size is known, or in deck mode', () => {
      assert.strictEqual(anchorRail({ doc: doc3, srcW: null, srcH: null }), '');
      const deck = toDeckDocument(doc3, 3240, 2000);
      assert.strictEqual(anchorRail({ doc: deck, srcW: 3240, srcH: 2000 }), '');
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

    test('a panorama stage with slack becomes the anchor surface; a deck stage does not', () => {
      const panorama = str(builder({ ...builderProps, srcW: 3240, srcH: 2000 }));
      assert.match(panorama, /carousel-studio__stage--anchor/);
      assert.match(panorama, /carousel-studio__anchor-rail/);
      assert.match(panorama, /title="Drag up or down to move the crop band"/);

      const deck = str(
        builder({
          ...builderProps,
          doc: toDeckDocument(doc3, 3240, 2000),
          srcW: 3240,
          srcH: 2000,
        }),
      );
      assert.doesNotMatch(deck, /carousel-studio__stage--anchor/);
      assert.doesNotMatch(deck, /carousel-studio__anchor-rail/);
    });

    test('assembles the studio from the state the page hands it, and reads none of its own', () => {
      const out = str(builder(builderProps));
      assert.match(out, /id="carousel-aspect"/);
      assert.match(out, /id="carousel-guides"/);
      assert.match(out, /data-action="pick-source"/);
      assert.match(out, /carousel-studio__stage/);
      assert.match(out, /carousel-studio__stage-slide/);
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

    test('deck mode emits a span-layer node per stage column for each span layer', () => {
      const deck = {
        ...toDeckDocument(doc3, 3000, 1000),
        spanLayers: [normalizeLayer({ type: 'text', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 }, text: 'H' })],
      };
      const out = str(builder({ ...builderProps, doc: deck, deckIndex: 0 }));
      const nodes = out.match(/carousel-studio__span-layer" data-span-layer="0"/g) || [];
      // One per stage column, and none in the rail — the rail is a thumbnail
      // strip, not a second editing surface.
      assert.strictEqual(nodes.length, 3);
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

  // ── Templates ─────────────────────────────────────────────────────────────

  describe('templateGallery', () => {
    const gallery = (o = {}) =>
      str(
        templateGallery({
          templates: [],
          loading: false,
          error: '',
          busy: false,
          canSave: true,
          ...o,
        }),
      );

    test('empty says what to do — v1 ships no built-ins, so empty is normal', () => {
      const out = gallery();
      assert.match(out, /No templates yet — import a \.pptx or a set of \.svg files to start\./);
      assert.doesNotMatch(out, /carousel-studio__template-list/);
    });

    test('a loading listing says so rather than claiming there are none', () => {
      const out = gallery({ loading: true });
      assert.match(out, /Loading templates…/);
      assert.doesNotMatch(out, /No templates yet/);
    });

    test('each template is choosable and deletable, by slug', () => {
      const out = gallery({ templates: [{ slug: 'bold-quote', name: 'Bold Quote' }] });
      assert.match(out, /data-action="apply-template"[\s\S]*?data-slug="bold-quote"/);
      assert.match(out, /data-action="delete-template"[\s\S]*?data-slug="bold-quote"/);
      assert.match(out, /Bold Quote/);
    });

    test('import is always offered; saving needs something to save', () => {
      assert.match(gallery(), /data-action="open-import"/);
      assert.doesNotMatch(
        gallery(),
        /data-action="open-save-template"[^>]*disabled/,
      );
      assert.match(
        gallery({ canSave: false }),
        /data-action="open-save-template"[\s\S]*?disabled/,
      );
    });

    test('busy disables every control that would start a second operation', () => {
      const out = gallery({ busy: true, templates: [{ slug: 'a', name: 'A' }] });
      assert.match(out, /data-action="open-import"[\s\S]*?disabled/);
      assert.match(out, /data-action="apply-template"[\s\S]*?disabled/);
    });

    test('a listing that failed says so in the gallery', () => {
      assert.match(gallery({ error: 'nope' }), /error-state[\s\S]*?nope/);
    });
  });

  describe('importDialog', () => {
    test('offers a file input that accepts every format the registry knows', () => {
      const out = str(importDialog({ busy: false, error: '' }));
      assert.match(out, /id="carousel-import-file"/);
      assert.match(out, /accept="[^"]*\.pptx[^"]*"/);
      assert.match(out, /accept="[^"]*\.svg[^"]*"/);
      assert.match(out, /multiple/);
      assert.match(out, /data-action="run-import"/);
    });

    test('the backdrop closes, and so do the two buttons that say so', () => {
      const out = str(importDialog({ busy: false, error: '' }));
      assert.match(out, /class="modal-overlay active carousel-studio__dialog" data-action="close-import"/);
      assert.match(out, /data-action="close-import" data-close="1"/);
    });

    test('an import in flight disables the button and says what it is doing', () => {
      const out = str(importDialog({ busy: true, error: '' }));
      assert.match(out, /Importing…/);
      assert.match(out, /data-action="run-import"[\s\S]*?disabled/);
    });

    test('a refusal is shown beside the file it is about', () => {
      assert.match(
        str(importDialog({ busy: false, error: 'Point cannot read notes.txt.' })),
        /error-state[\s\S]*?Point cannot read notes\.txt\./,
      );
    });
  });

  describe('saveTemplateDialog', () => {
    test('shows the name and the slug it will be stored under, both editable', () => {
      const out = str(saveTemplateDialog({ name: 'Bold Quote', slug: 'bold-quote', busy: false, error: '' }));
      assert.match(out, /id="carousel-template-name"[\s\S]*?value="Bold Quote"/);
      assert.match(out, /id="carousel-template-slug"[\s\S]*?value="bold-quote"/);
      assert.match(out, /data-action="submit-save-template"/);
    });

    test('says that a slug already in use replaces — the store upserts', () => {
      const out = str(saveTemplateDialog({ name: '', slug: '', busy: false, error: '' }));
      assert.match(out, /replaces that template/);
    });
  });

  describe('importReportPanel', () => {
    const report = (o = {}) => ({
      format: 'pptx',
      file: 'Deck.pptx',
      slides: 4,
      sourceSlides: 5,
      shapes: { kept: 14, total: 22 },
      aspect: { from: '16:9', to: '4:5', axis: 'x', margin: 0.2, note: '16:9 fitted into 4:5 — 20% margin each side' },
      fonts: [],
      assets: { count: 0, bytes: 0 },
      dropped: [],
      failed: [],
      warnings: [],
      order: [],
      ...o,
    });

    test('nothing to report renders nothing', () => {
      assert.strictEqual(importReportPanel(null), '');
    });

    test('leads with what was kept and what it cost', () => {
      const out = str(importReportPanel(report()));
      assert.match(out, /Imported Deck\.pptx/);
      assert.match(out, /4 slides of 5 — 1 could not be read/);
      assert.match(out, /14 of 22 shapes kept/);
      assert.match(out, /16:9 fitted into 4:5 — 20% margin each side/);
    });

    test('the fonts line says plainly that type renders in the theme font', () => {
      const out = str(importReportPanel(report({ fonts: ['Poppins', 'Inter'] })));
      assert.match(out, /Fonts in the file: Poppins, Inter/);
      assert.match(out, /site's theme font, not the template's/);
    });

    test("a warning — .5's outlined text, say — is shown, not swallowed", () => {
      const out = str(
        importReportPanel(report({ warnings: ['This SVG has its text outlined.'] })),
      );
      assert.match(out, /carousel-studio__report-warn[\s\S]*?This SVG has its text outlined\./);
    });

    test('drops are counted per kind and per slide', () => {
      const out = str(
        importReportPanel(
          report({
            dropped: [
              { slide: 3, what: 'groups', n: 3 },
              { slide: null, what: 'the slide master', n: 1 },
            ],
          }),
        ),
      );
      assert.match(out, /Slide 4: 3 × groups/);
      assert.match(out, /The deck: the slide master/);
      assert.doesNotMatch(out, /1 × the slide master/);
    });

    test('unreadable parts are named with their reason', () => {
      const out = str(
        importReportPanel(report({ failed: [{ slide: 1, part: 'slide2.xml', reason: 'malformed' }] })),
      );
      assert.match(out, /Slide 2: slide2\.xml — malformed/);
    });

    test('inlined images are reported in megabytes, and the file order when the format has none', () => {
      const out = str(
        importReportPanel(report({ assets: { count: 3, bytes: 2 * 1024 * 1024 }, order: ['a.svg', 'b.svg'] })),
      );
      assert.match(out, /3 images carried in the\s+template \(2\.0 MB\)/);
      assert.match(out, /Slide order: a\.svg, b\.svg/);
    });
  });
});
