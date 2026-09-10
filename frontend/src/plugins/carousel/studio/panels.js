/**
 * Carousel Studio — the markup half.
 *
 * Every export here is a pure function of the values it is handed: it reads no
 * component state, holds nothing between calls, and returns an `html` template.
 * That is the whole point of the split — the studio's chrome can be rendered,
 * and asserted on, without a mounted page, and the page keeps exactly one
 * writer for the document (see `index.js`).
 *
 * The controls that carry live state — the count slider, the aspect select, the
 * guides checkbox, the fill's colour and angle fields — are wired by their id
 * in `index.js` after render. Ids used here are that contract; renaming one
 * without following it there is a silently dead control.
 */

import { html, raw } from "../../../utils/helpers.js";
import { GRIP_SVG, REFRESH_SVG } from "../../../utils/icons.js";
import {
  canvasSize,
  fitReport,
  safeAreaRect,
  slideCountOptions,
  spanLayerCoverage,
} from "../geometry.js";
import { MAX_SLIDES, MIN_SLIDES } from "./bounds.js";

/** Fit-panel radio: the two `cover` variants (free count vs. width-filling
 *  count) plus the two pixel-exact strategies. `fill` stores `strategy: 'cover'`
 *  and only differs from `cover` by the slide count it sets. */
const FIT_MODES = [
  ["cover", "Cover"],
  ["fill", "Fill"],
  ["exact", "Exact"],
  ["pad", "Pad"],
];

/** Per-slide fit, deck mode only. */
const SLIDE_FITS = [
  ["cover", "Cover"],
  ["contain", "Contain"],
];

/** Per-slide background fill, deck mode only and only where a slide actually
 *  has a letterbox to fill. `blur` is stored as `bg: null` — it is the render's
 *  default, and storing it explicitly would change the slide's `specHash`
 *  without changing a pixel. */
const SLIDE_BGS = [
  ["blur", "Blur"],
  ["solid", "Solid"],
  ["gradient", "Gradient"],
];

const ASPECT_OPTIONS = [
  ["4:5", "Portrait 4:5"],
  ["1:1", "Square 1:1"],
  ["1.91:1", "Landscape 1.91:1"],
];

/** The five layer types, with the label their "Add" chip and list row carry.
 *  `image` is called "Logo" — the S3 use is a wordmark, and the default source
 *  is the `logo_url` setting. */
const LAYER_KINDS = [
  ["text", "Text"],
  ["image", "Logo"],
  ["rect", "Rectangle"],
  ["counter", "Counter"],
  ["arrow", "Arrow"],
];

const LAYER_ALIGNS = [
  ["left", "Left"],
  ["center", "Centre"],
  ["right", "Right"],
];
const LAYER_VALIGNS = [
  ["top", "Top"],
  ["middle", "Middle"],
  ["bottom", "Bottom"],
];

/** `<input type="color">` accepts `#rrggbb` and nothing else, so a shorthand or
 *  alpha hex from the document is widened for display rather than silently
 *  reset to black by the browser. */
export function colorInputValue(color) {
  const c = String(color || "").trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/.exec(c);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{8}$/.test(c)) return c.slice(0, 7);
  return /^#[0-9a-f]{6}$/.test(c) ? c : "#000000";
}

/**
 * Undo and redo. Buttons as well as keys because a phone has no Ctrl — and
 * their disabled state is the only place the history's depth is visible, so it
 * is read straight off the ring rather than tracked in the page's state.
 * Both go dark mid-render: the document a render is uploading from must not
 * move under it.
 *
 * @param {{canUndo: boolean, canRedo: boolean, busy: boolean}} o
 */
export function historyButtons({ canUndo, canRedo, busy }) {
  const step = (action, glyph, label, hint, enabled) => html`
    <button
      type="button"
      class="carousel-studio__chip"
      data-action="${action}"
      title="${label} (${hint})"
      aria-label="${label}"
      ${enabled && !busy ? "" : "disabled"}
    >
      ${raw(glyph)}
    </button>`;
  return html`
    <div class="carousel-studio__history" role="group" aria-label="History">
      ${step("undo", "&#8630;", "Undo", "Ctrl+Z", canUndo)}
      ${step("redo", "&#8631;", "Redo", "Ctrl+Shift+Z", canRedo)}
    </div>`;
}

/**
 * The header actions: back, undo/redo, the render button and its progress, the
 * dirty badge, and Remove once a carousel exists.
 *
 * @param {{busy: boolean, renderProgress: {done: number, total: number}|null,
 *   hasCarousel: boolean, dirty: boolean, hasSource: boolean,
 *   canUndo?: boolean, canRedo?: boolean}} o
 */
export function actionsBar({
  busy,
  renderProgress,
  hasCarousel,
  dirty,
  hasSource,
  canUndo = false,
  canRedo = false,
}) {
  const label = busy
    ? renderProgress
      ? `Rendering… ${renderProgress.done}/${renderProgress.total}`
      : "Rendering…"
    : "Render";
  return html`
    <button class="btn btn-secondary" data-action="back-to-post">&larr; Back to post</button>
    ${historyButtons({ canUndo, canRedo, busy })}
    <button
      id="carousel-render-btn"
      class="btn btn-primary ${dirty && !busy ? "carousel-studio__render-btn--dirty" : ""}"
      data-action="render"
      ${!hasSource || busy ? "disabled" : ""}
    >
      ${raw(REFRESH_SVG)}<span class="btn-label">${label}</span>
    </button>
    ${busy && renderProgress
      ? html`
          <div
            class="carousel-studio__progress"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="${String(renderProgress.total)}"
            aria-valuenow="${String(renderProgress.done)}"
          >
            <div
              class="carousel-studio__progress-bar"
              style="width:${String(Math.round((renderProgress.done / renderProgress.total) * 100))}%"
            ></div>
          </div>`
      : ""}
    ${dirty && !busy
      ? html`<span class="carousel-studio__dirty-badge" role="status"
          >Unsaved — press Render</span
        >`
      : ""}
    ${hasCarousel
      ? html`<button
          class="btn btn-danger"
          data-action="remove-carousel"
          ${busy ? "disabled" : ""}
        >
          Remove carousel
        </button>`
      : ""}`;
}

/** Nothing picked yet — the studio needs one image before it has anything to
 *  slice. */
export function pickPrompt() {
  return html`
    <div class="carousel-studio__pick">
      <p>Pick one image to slice into slides.</p>
      <button class="btn btn-primary" data-action="pick-source">Choose image</button>
    </div>`;
}

/**
 * The two layers of one deck frame, in paint order.
 *
 * The fill spans the whole frame and the image sits on top of it, exactly as
 * `paintSlide` fills the canvas and then blits the crop over it. Both are
 * their own elements rather than backgrounds of the frame: a contained
 * slide's box is smaller than the frame, so only an element cut down to the
 * content rect keeps the source from bleeding into the letterbox — and only a
 * separate element can carry the `blur()` the fill needs without blurring the
 * image and the frame's border with it.
 */
function deckLayers() {
  return html`
    <span class="carousel-studio__frame-bg"></span>
    <span class="carousel-studio__frame-img"></span>`;
}

/**
 * One empty positioned element per layer of `slide`, in paint (array) order so
 * DOM source order is the stacking order. `preview.js` (`paintDeckLayers`)
 * fills them from `layerCSS`; an element whose `data-layer` outruns the list —
 * a layer deleted since the last paint — is hidden there.
 *
 * @param {import('../document.js').CarouselSlide} slide
 */
function layerNodes(slide) {
  return (slide.layers || []).map(
    (_, j) => html`<span class="carousel-studio__layer" data-layer="${String(j)}"></span>`,
  );
}

/**
 * One empty positioned element per span layer, inside every stage column.
 * `preview.js` (`paintSpanLayers`) positions each from `spanLayerRect` — a
 * slide-local rect that starts off-frame and overflows where the layer crosses a
 * seam, which the host's `overflow: hidden` then clips, so the preview shows the
 * same discontinuity the JPEG will. A node whose `data-span-layer` outruns the
 * list is hidden there.
 *
 * @param {import('../document.js').CarouselDoc} doc
 */
function spanLayerNodes(doc) {
  return (doc.spanLayers || []).map(
    (_, j) =>
      html`<span class="carousel-studio__span-layer" data-span-layer="${String(j)}"></span>`,
  );
}

/** The eight resize-handle anchors, in DOM order. `hitLayer` in `gestures.js`
 *  derives the same set geometrically — these are the visible affordance, not
 *  the hit target. */
const HANDLE_ANCHORS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * The selection chrome for a stage column: an outline box carrying the eight
 * resize handles, plus an empty layer for `paintLayerChrome` to draw snap guides
 * into. Emitted while a layer is selected — for the selected slide's column
 * alone when that layer is a slide layer, for every column when it spans them.
 * Its absence is how a deselect clears it on the next render.
 *
 * @param {boolean} active  this column can show the selected layer
 */
function layerChrome(active) {
  if (!active) return "";
  return html`
    <span class="carousel-studio__chrome">
      <span class="carousel-studio__chrome-box">
        ${HANDLE_ANCHORS.map(
          (a) =>
            html`<span
              class="carousel-studio__handle carousel-studio__handle--${a}"
              data-anchor="${a}"
            ></span>`,
        )}
      </span>
      <span class="carousel-studio__snap"></span>
    </span>`;
}

/** A one-line name for a layer row: the type, plus the field that tells two of
 *  the same type apart. */
function layerLabel(layer) {
  if (layer.type === "text") {
    const t = (layer.text || "").trim().replace(/\s+/g, " ");
    if (!t) return "Text";
    return `Text — ${t.length > 24 ? `${t.slice(0, 24)}…` : t}`;
  }
  if (layer.type === "image") return "Logo";
  if (layer.type === "rect") return "Rectangle";
  if (layer.type === "counter") return `Counter — ${layer.format || "{i}/{n}"}`;
  if (layer.type === "arrow") return `Arrow ${layer.direction === "left" ? "←" : "→"}`;
  return layer.type;
}

/**
 * The builder: mode toggle, stage, filmstrip, the mode's own panel, the
 * doc-level controls, and the strip of slides really in the post.
 *
 * @param {object} o
 * @param {import('../document.js').CarouselDoc} o.doc
 * @param {boolean} o.showGuides
 * @param {number} o.selected      the raw selection, for the strip's highlight
 * @param {number} o.deckIndex     the selection pinned inside the deck
 * @param {number|null} o.srcW
 * @param {number|null} o.srcH
 * @param {boolean} o.busy
 * @param {string} o.fitMode       which `FIT_MODES` radio the document reads as
 * @param {boolean} o.hasPad       whether the deck's selected slide letterboxes
 * @param {number|null} o.selectedLayer  index into the active list (a slide's
 *   `layers`, or `doc.spanLayers` when `layerScope` is `"span"`)
 * @param {"slide"|"span"} o.layerScope  which list `selectedLayer` indexes
 * @param {string} o.logoUrl       the `logo_url` setting, the image layer default
 * @param {string[]} o.renderedPaths
 * @param {boolean} [o.propsOpen]  is the properties panel showing? A rail wide,
 *   a bottom sheet below 64em — the same class name and the same state-class
 *   placement the post editor's Details panel uses.
 * @param {number} [o.stageZoom]   multiplier on the stage's CSS height budget,
 *   emitted as the one custom property the stylesheet reads.
 */
export function builder({
  doc,
  showGuides,
  selected,
  deckIndex,
  srcW,
  srcH,
  busy,
  fitMode,
  hasPad,
  selectedLayer,
  layerScope = "slide",
  logoUrl,
  renderedPaths,
  propsOpen = true,
  stageZoom = 1,
}) {
  const deck = doc.mode === "deck";
  const n = doc.slides.length;
  const [w, h] = canvasSize(doc.aspect);
  const slideChrome = layerScope === "slide" && selectedLayer != null;
  // A span layer is grabbable on every column it crosses, so every column gets
  // a chrome node and `paintSpanChrome` hides the ones the layer misses — which
  // also means a drag that carries it over a seam finds chrome waiting there,
  // without a rebuild mid-gesture.
  const spanChrome = layerScope === "span" && selectedLayer != null;
  const spanNodes = spanLayerNodes(doc);

  const dividers = Array.from({ length: n - 1 }, (_, i) => {
    const left = ((i + 1) / n) * 100;
    return html`<span class="carousel-studio__divider" style="left:${String(left)}%"></span>`;
  });

  // Panorama's on-stage anchor control. Emitted (and so bound by
  // `createAnchorGesture`) only when there is slack to drag through — which is
  // also what decides the stage's `touch-action`, since a stage with nothing to
  // move must leave a vertical finger to the page.
  const rail = anchorRail({ doc, srcW, srcH });

  const sa = safeAreaRect(doc.aspect);
  const guides = showGuides
    ? Array.from({ length: n }, (_, i) => {
        const style = [
          `left:${String(((i + sa.x / w) / n) * 100)}%`,
          `width:${String((sa.w / w / n) * 100)}%`,
          `top:${String((sa.y / h) * 100)}%`,
          `height:${String((sa.h / h) * 100)}%`,
        ].join(";");
        return html`<span class="carousel-studio__safe" style="${style}"></span>`;
      })
    : "";

  // In deck mode the stage is no longer one crop band projected across the
  // deck — it is n independently framed slides laid side by side, and each
  // column is the editing surface: `gestures.js` binds these, so a pan, a
  // zoom, a layer drag and an arrow nudge all happen at the size the user is
  // actually looking at.
  const stageSlides = deck
    ? doc.slides.map(
        (slide, i) => html`
          <span
            class="carousel-studio__stage-slide ${i === selected ? "is-selected" : ""}"
            data-slice="${String(i)}"
            tabindex="0"
            role="group"
            aria-label="Slide ${String(i + 1)} framing — drag to pan, wheel to zoom, arrow keys to nudge"
            style="left:${String((i / n) * 100)}%;width:${String(100 / n)}%"
          >
            ${deckLayers()}${layerNodes(slide)}${spanNodes}${layerChrome(
              (i === deckIndex && slideChrome) || spanChrome,
            )}
          </span>`,
      )
    : "";

  // The deck filmstrip is a rail, not a second editing surface: a thumbnail,
  // a slide number and the selected state. Its only job is to move the
  // selection, so it is a button — the layer nodes, span nodes and chrome that
  // used to be duplicated here live on the stage alone.
  //
  // In Slides mode each frame is wrapped with its own drag handle, because
  // `attachPointerReorder` claims the pointer on press: a handle *is* the
  // frame would mean a press that never becomes the click that selects it.
  // The handle carries `data-slide`, the frame `data-slice` — the frame is a
  // paint host and the handle is not (see the note on `pick-source` in
  // `index.js`).
  const strip = doc.slides.map((_slide, i) =>
    deck
      ? html`
          <div class="carousel-studio__rail-item" data-slide="${String(i)}">
            <button
              type="button"
              class="carousel-studio__frame carousel-studio__frame--deck ${i === selected
                ? "is-selected"
                : ""}"
              data-slice="${String(i)}"
              data-action="select-slide"
              aria-pressed="${i === selected ? "true" : "false"}"
              aria-label="Select slide ${String(i + 1)}"
              style="aspect-ratio:${String(w)}/${String(h)}"
            >
              ${deckLayers()}
              <span class="carousel-studio__frame-num">${String(i + 1)}</span>
            </button>
            <button
              type="button"
              class="carousel-studio__rail-handle"
              data-slide="${String(i)}"
              aria-label="Reorder slide ${String(i + 1)} — drag, or press the left and right arrow keys"
            >
              ${raw(GRIP_SVG)}
            </button>
          </div>`
      : html`
          <div
            class="carousel-studio__frame"
            data-slice="${String(i)}"
            style="aspect-ratio:${String(w)}/${String(h)}"
          ></div>`,
  );

  // Add / duplicate / delete act on the selected slide, so they are one row
  // under the rail rather than three chips on every frame. Slides mode only:
  // a panorama's count is derived from the fit panel, and a control that added
  // a column there would be offering to break the derivation.
  const railTools = deck
    ? html`
        <div class="carousel-studio__rail-tools" role="group" aria-label="Slides">
          <button
            type="button"
            class="carousel-studio__chip"
            data-action="add-slide"
            data-slide="${String(deckIndex)}"
            ${n >= MAX_SLIDES ? "disabled" : ""}
          >
            + Slide
          </button>
          <button
            type="button"
            class="carousel-studio__chip"
            data-action="duplicate-slide"
            data-slide="${String(deckIndex)}"
            ${n >= MAX_SLIDES ? "disabled" : ""}
          >
            Duplicate
          </button>
          <button
            type="button"
            class="carousel-studio__chip"
            data-action="delete-slide"
            data-slide="${String(deckIndex)}"
            ${n <= MIN_SLIDES ? "disabled" : ""}
          >
            Delete
          </button>
          <span class="carousel-studio__fit-dims">
            ${String(n)} of ${String(MAX_SLIDES)} slides · acting on slide
            ${String(deckIndex + 1)}
          </span>
        </div>`
    : "";

  // The controls bar acts on the whole document, so this carries no
  // `data-slide` — and in Slides mode that is the studio's original behaviour,
  // one photo on every slide with each slide's framing kept. It stays reachable
  // here now that `deckPanel` can change a single slide's photo instead.
  const sourceButton = html`
    <button
      class="btn btn-secondary"
      data-action="pick-source"
      title="${deck
        ? "Put one photo on every slide, keeping each slide's framing"
        : "Choose the photo to cut across the slides"}"
    >
      ${deck ? "Use one photo for all slides" : "Change photo"}
    </button>`;

  const renderedStrip = renderedPaths.length
    ? html`
        <div class="carousel-studio__rendered">
          <h2 class="carousel-studio__subhead">Rendered slides</h2>
          <div class="carousel-studio__slides">
            ${renderedPaths.map(
              (p) => html`<img class="carousel-studio__slide" src="${p}" alt="" loading="lazy" />`,
            )}
          </div>
        </div>`
    : "";

  return html`
    <div
      class="carousel-studio__builder ${propsOpen ? "is-details-open" : ""}"
      style="--carousel-stage-zoom:${String(stageZoom)}"
    >
      ${modeToggle({ mode: doc.mode, canDeck: Boolean(srcW && srcH), busy })}

      <div class="carousel-studio__stage-scroll">
        <div
          class="carousel-studio__stage ${deck ? "carousel-studio__stage--deck" : ""} ${rail
            ? "carousel-studio__stage--anchor"
            : ""}"
          style="aspect-ratio:${String(n * w)}/${String(h)}"
          ${rail ? raw('title="Drag up or down to move the crop band"') : ""}
        >
          ${stageSlides}${dividers}${guides}${rail}
        </div>
      </div>

      ${stageBar({ propsOpen, stageZoom })}

      <div
        class="carousel-studio__filmstrip"
        aria-label="${deck ? "Slides — drag a handle to reorder" : "Slide preview"}"
      >
        ${strip}
      </div>
      ${railTools}

      <div class="carousel-studio__props-backdrop" data-action="close-props"></div>
      <aside
        class="carousel-studio__props"
        id="carousel-props"
        aria-label="Slide properties"
        aria-hidden="${propsOpen ? "false" : "true"}"
      >
        <button
          type="button"
          class="carousel-studio__props-close btn btn-secondary"
          data-action="close-props"
          aria-label="Close properties"
        >
          &times;
        </button>
        ${deck
          ? html`${deckPanel({ doc, index: deckIndex, hasPad })}${layerPanel({
              doc,
              index: deckIndex,
              selectedLayer,
              layerScope,
              logoUrl,
            })}`
          : fitPanel({ doc, srcW, srcH, fitMode })}
      </aside>

      <div class="carousel-studio__controls">
        ${deck
          ? ""
          : html`
              <label class="carousel-studio__control">
                <span>Slides: <output id="carousel-n-out">${String(n)}</output></span>
                <input
                  type="range"
                  id="carousel-n"
                  min="${String(MIN_SLIDES)}"
                  max="${String(MAX_SLIDES)}"
                  value="${String(n)}"
                />
              </label>`}

        <label class="carousel-studio__control">
          <span>Aspect</span>
          <select id="carousel-aspect">
            ${ASPECT_OPTIONS.map(
              ([val, text]) => html`
                <option value="${val}" ${val === doc.aspect ? "selected" : ""}>${text}</option>`,
            )}
          </select>
        </label>

        <label class="carousel-studio__control carousel-studio__control--check">
          <input type="checkbox" id="carousel-guides" ${showGuides ? "checked" : ""} />
          <span>Safe-area guides</span>
        </label>

        ${sourceButton}
      </div>

      ${renderedStrip}
    </div>`;
}

/**
 * The bar under the stage: stage zoom on the left, the properties toggle on the
 * right. Neither touches the document — zoom writes one CSS custom property on
 * the builder root and the toggle flips one state class, so both are applied
 * without a rebuild (see `_setStageZoom` / `_toggleProps` in `index.js`).
 *
 * "100%" here means the stage's own height budget, not 1:1 with the 1350px
 * canvas — the canvas is taller than any laptop.
 *
 * @param {{propsOpen: boolean, stageZoom: number}} o
 */
export function stageBar({ propsOpen, stageZoom }) {
  return html`
    <div class="carousel-studio__stage-bar">
      <div class="carousel-studio__zoom" role="group" aria-label="Stage zoom">
        <button
          type="button"
          class="carousel-studio__chip"
          data-action="stage-zoom"
          data-zoom="out"
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <output class="carousel-studio__zoom-readout" id="carousel-zoom-readout"
          >${String(Math.round(stageZoom * 100))}%</output
        >
        <button
          type="button"
          class="carousel-studio__chip"
          data-action="stage-zoom"
          data-zoom="in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          class="carousel-studio__chip"
          data-action="stage-zoom"
          data-zoom="fit"
          title="Fit the whole deck across the stage"
        >
          Fit
        </button>
        <button
          type="button"
          class="carousel-studio__chip"
          data-action="stage-zoom"
          data-zoom="reset"
          title="Back to the default stage height"
        >
          100%
        </button>
      </div>

      <button
        type="button"
        id="carousel-props-toggle"
        class="btn btn-secondary"
        data-action="toggle-props"
        aria-controls="carousel-props"
        aria-expanded="${propsOpen ? "true" : "false"}"
      >
        ${propsOpen ? "Hide properties" : "Properties"}
      </button>
    </div>`;
}

/**
 * **Panorama** / **Slides** — the choice the user is actually making: one wide
 * photo cut across every slide, or a photo per slide. The stored `doc.mode`
 * values stay `split` and `deck` (`MODES` in `document.js`), so this is naming
 * at the view layer only: no migration, and the code and the docs keep one
 * vocabulary while the chips speak the user's.
 *
 * Slides is unavailable until the source pixel size is known — there would be
 * nothing to derive the per-slide crops from.
 *
 * @param {{mode: string, canDeck: boolean, busy: boolean}} o
 */
export function modeToggle({ mode, canDeck, busy }) {
  return html`
    <div class="carousel-studio__modes" role="group" aria-label="Framing mode">
      <button
        type="button"
        class="carousel-studio__chip ${mode === "split" ? "is-active" : ""}"
        data-action="mode"
        data-mode="split"
        aria-pressed="${mode === "split" ? "true" : "false"}"
        ${busy ? "disabled" : ""}
        title="One wide photo cut across every slide"
      >
        Panorama
      </button>
      <button
        type="button"
        class="carousel-studio__chip ${mode === "deck" ? "is-active" : ""}"
        data-action="mode"
        data-mode="deck"
        aria-pressed="${mode === "deck" ? "true" : "false"}"
        ${busy || !canDeck ? "disabled" : ""}
        title="${canDeck
          ? "A photo per slide — one shared, or a different one on each"
          : "Waiting for the source dimensions"}"
      >
        Slides
      </button>
      <span class="carousel-studio__mode-hint">
        ${mode === "deck"
          ? "A photo per slide, framed slide by slide. Going back to Panorama keeps only the first slide's photo and discards the framing."
          : "One wide photo, cut into a column per slide. Switching to Slides freezes exactly what you see — nothing moves."}
      </span>
    </div>`;
}

/**
 * Deck mode's panel: which slide is selected, what it shows, and the per-slide
 * `fit`. The split fit panel (count chips, strategy radios, `anchorY` slider)
 * is not shown here at all — none of those controls drives a deck slide, and
 * leaving them live would be a lie.
 *
 * @param {{doc: import('../document.js').CarouselDoc, index: number,
 *   hasPad: boolean}} o  `hasPad` is the selected slide's own answer: the
 *   caller owns the source pixels the question needs.
 */
export function deckPanel({ doc, index, hasPad }) {
  const slide = doc.slides[index];
  if (!slide) return "";

  const { crop } = slide;
  const zoom = crop.w > 0 ? Math.round(100 / crop.w) : 100;
  const readout = [
    `showing ${Math.round(crop.w * 100)}% × ${Math.round(crop.h * 100)}% of the source`,
    `${zoom}% zoom`,
    slide.fit === "contain" ? "letterboxed" : "filling the frame",
  ].join(" · ");

  return html`
    <div class="carousel-studio__fit carousel-studio__deck">
      <p class="carousel-studio__fit-dims">
        Slide ${String(index + 1)} of ${String(doc.slides.length)} · drag to pan ·
        wheel or pinch to zoom · arrow keys nudge
      </p>

      <div class="carousel-studio__fit-chips" role="group" aria-label="Slide fit">
        ${SLIDE_FITS.map(
          ([val, text]) => html`
            <button
              type="button"
              class="carousel-studio__chip ${slide.fit === val ? "is-active" : ""}"
              data-action="slide-fit"
              data-slide="${String(index)}"
              data-fit="${val}"
              aria-pressed="${slide.fit === val ? "true" : "false"}"
            >
              ${text}
            </button>`,
        )}
        <button
          type="button"
          class="carousel-studio__chip"
          data-action="reset-slide"
          data-slide="${String(index)}"
        >
          Reset framing
        </button>
      </div>

      <div class="carousel-studio__fit-chips" role="group" aria-label="Slide photo">
        <button
          type="button"
          class="carousel-studio__chip"
          data-action="pick-source"
          data-slide="${String(index)}"
        >
          Change this slide's photo
        </button>
      </div>

      ${hasPad ? bgControl({ index, slide }) : ""}

      <p class="carousel-studio__fit-readout" aria-live="polite">${readout}</p>
    </div>`;
}

/**
 * The background control for one deck slide — shown only when the slide
 * really has a letterbox to fill (`deckPanel` asks that question). A `cover`
 * slide covers its frame, and offering a fill that paints nothing is worse
 * than offering none.
 *
 * `solid` adds a colour input; `gradient` adds an angle and its two ends. Both
 * are committed through `_setSlideFraming` in `index.js`, so `normalizeBg` is
 * the only thing that decides what a value means.
 *
 * @param {{index: number, slide: import('../document.js').CarouselSlide}} o
 */
export function bgControl({ index, slide }) {
  const bg = slide.bg;
  const type = bg?.type || "blur";
  const solid = bg?.type === "solid" ? bg : null;
  const gradient = bg?.type === "gradient" ? bg : null;

  return html`
    <div class="carousel-studio__bg">
      <span class="carousel-studio__bg-label" id="carousel-bg-label">Letterbox fill</span>
      <div class="carousel-studio__fit-chips" role="group" aria-labelledby="carousel-bg-label">
        ${SLIDE_BGS.map(
          ([val, text]) => html`
            <button
              type="button"
              class="carousel-studio__chip ${type === val ? "is-active" : ""}"
              data-action="slide-bg"
              data-slide="${String(index)}"
              data-bg="${val}"
              aria-pressed="${type === val ? "true" : "false"}"
            >
              ${text}
            </button>`,
        )}
      </div>

      ${solid
        ? html`
            <label class="carousel-studio__bg-field">
              <span>Colour</span>
              <input
                type="color"
                id="carousel-bg-color"
                value="${colorInputValue(solid.color)}"
              />
            </label>`
        : ""}
      ${gradient
        ? html`
            <label class="carousel-studio__bg-field">
              <span>From</span>
              <input
                type="color"
                id="carousel-bg-from"
                value="${colorInputValue(gradient.stops[0].color)}"
              />
            </label>
            <label class="carousel-studio__bg-field">
              <span>To</span>
              <input
                type="color"
                id="carousel-bg-to"
                value="${colorInputValue(
                  gradient.stops[gradient.stops.length - 1].color,
                )}"
              />
            </label>
            <label class="carousel-studio__bg-field">
              <span
                >Angle:
                <output id="carousel-bg-angle-out">${String(gradient.angle)}°</output></span
              >
              <input
                type="range"
                id="carousel-bg-angle"
                min="0"
                max="359"
                step="1"
                value="${String(gradient.angle)}"
              />
            </label>`
        : ""}
    </div>`;
}

/** A one-line "spans slides 2–3" (or "off-canvas") hint for a span row. */
function spanRangeLabel(covered) {
  if (!covered.length) return "off-canvas";
  const first = covered[0] + 1;
  const last = covered[covered.length - 1] + 1;
  return first === last ? `slide ${first}` : `slides ${first}–${last}`;
}

/**
 * One "top of stack first" list of layer rows, its buttons all tagged with
 * `data-scope` so the delegated handlers in `index.js` route an edit to the
 * slide's own `layers` or to `doc.spanLayers` without a second family of
 * actions. `meta(j)` is an optional trailing note per row (the span range).
 *
 * @param {import('../document.js').CarouselLayer[]} layers
 * @param {{scope: "slide"|"span", selectedLayer: number|null,
 *   meta?: (j: number) => string, labelledBy: string}} o
 */
function layerRows(layers, { scope, selectedLayer, meta, labelledBy }) {
  const rows = layers
    .map((layer, j) => ({ layer, j }))
    .reverse()
    .map(
      ({ layer, j }) => html`
        <li class="carousel-studio__layer-row ${j === selectedLayer ? "is-selected" : ""}">
          <button
            type="button"
            class="carousel-studio__layer-name"
            data-action="select-layer"
            data-scope="${scope}"
            data-index="${String(j)}"
            aria-pressed="${j === selectedLayer ? "true" : "false"}"
          >
            ${layerLabel(layer)}${meta ? html`<span class="carousel-studio__layer-meta"> · ${meta(j)}</span>` : ""}
          </button>
          <button
            type="button"
            class="carousel-studio__chip"
            data-action="layer-raise"
            data-scope="${scope}"
            data-index="${String(j)}"
            aria-label="Move layer up"
            ${j === layers.length - 1 ? "disabled" : ""}
          >
            ↑
          </button>
          <button
            type="button"
            class="carousel-studio__chip"
            data-action="layer-lower"
            data-scope="${scope}"
            data-index="${String(j)}"
            aria-label="Move layer down"
            ${j === 0 ? "disabled" : ""}
          >
            ↓
          </button>
          <button
            type="button"
            class="carousel-studio__chip"
            data-action="delete-layer"
            data-scope="${scope}"
            data-index="${String(j)}"
            aria-label="Delete layer"
          >
            ✕
          </button>
        </li>`,
    );

  return layers.length
    ? html`<ul class="carousel-studio__layer-list" aria-labelledby="${labelledBy}">
        ${rows}
      </ul>`
    : "";
}

/** The "+ Text / + Logo / …" add chips for one scope. */
function addLayerChips(scope) {
  return html`
    <div class="carousel-studio__fit-chips" role="group" aria-label="Add layer">
      ${LAYER_KINDS.map(
        ([type, text]) => html`
          <button
            type="button"
            class="carousel-studio__chip"
            data-action="add-layer"
            data-scope="${scope}"
            data-type="${type}"
          >
            + ${text}
          </button>`,
      )}
    </div>`;
}

/**
 * Deck mode's layer panel: add / select / reorder / delete for the selected
 * slide's own layers **and** for the deck's spanning layers, plus the property
 * form for whichever layer is selected.
 *
 * Each list is shown **top of stack first**: users think in stacking order and
 * the arrays are back-to-front, so the view is reversed here, never the
 * document. "Move up" raises a layer toward the front — a later array index.
 *
 * Every add / select / reorder / delete button is a delegated `action` carrying
 * `data-scope` (`"slide"` or `"span"`); the form's fields carry the
 * `#carousel-layer-*` ids `_wireLayerFields` (`index.js`) binds. Span layers
 * reuse the same five types and the same form — a second family of editors for
 * one schema is the failure mode. The studio never constructs a layer literal:
 * an add goes through `addLayer` and every edit through `updateLayer`
 * (`document.js`), the same rule framing keeps. The form is one of two ways in:
 * a span layer is dragged, resized and snapped on the stage as well, in deck
 * coordinates (`gestures.js`), and both routes commit through `updateLayer`.
 *
 * @param {{doc: import('../document.js').CarouselDoc, index: number,
 *   selectedLayer: number|null, layerScope: "slide"|"span", logoUrl: string}} o
 */
export function layerPanel({ doc, index, selectedLayer, layerScope = "slide", logoUrl }) {
  const slide = doc.slides[index];
  if (!slide) return "";
  const slideLayers = slide.layers || [];
  const spanLayers = doc.spanLayers || [];
  const n = doc.slides.length;

  const slideSel = layerScope === "slide" ? selectedLayer : null;
  const spanSel = layerScope === "span" ? selectedLayer : null;
  const list = layerScope === "span" ? spanLayers : slideLayers;
  const selected = selectedLayer == null ? null : list[selectedLayer] || null;

  return html`
    <div class="carousel-studio__layers">
      <div class="carousel-studio__layers-head">
        <span class="carousel-studio__bg-label" id="carousel-layers-label">
          Slide ${String(index + 1)} layers
        </span>
        ${addLayerChips("slide")}
      </div>
      ${slideLayers.length
        ? layerRows(slideLayers, {
            scope: "slide",
            selectedLayer: slideSel,
            labelledBy: "carousel-layers-label",
          })
        : html`<p class="carousel-studio__fit-dims">No layers on this slide yet.</p>`}

      <div class="carousel-studio__layers-head carousel-studio__layers-head--span">
        <span class="carousel-studio__bg-label" id="carousel-span-layers-label">
          Deck layers <span class="carousel-studio__layer-meta">(across all slides)</span>
        </span>
        ${addLayerChips("span")}
      </div>
      ${spanLayers.length
        ? layerRows(spanLayers, {
            scope: "span",
            selectedLayer: spanSel,
            meta: (j) => spanRangeLabel(spanLayerCoverage(spanLayers[j], n, doc.aspect)),
            labelledBy: "carousel-span-layers-label",
          })
        : html`<p class="carousel-studio__fit-dims">
            No deck layers — a headline or logo lockup placed here runs across the seams.
          </p>`}

      ${selected ? layerForm(selected, logoUrl) : ""}
    </div>`;
}

/**
 * The property form for the selected layer, following `bgControl`'s shape: only
 * the fields that layer's `type` has, each with a `#carousel-layer-*` id
 * `index.js` wires for a live-preview `input` and a commit-on-`change`.
 *
 * @param {import('../document.js').CarouselLayer} layer a normalized layer
 * @param {string} logoUrl the `logo_url` setting — shown as an `image` layer's
 *   default source when it carries none of its own
 */
export function layerForm(layer, logoUrl) {
  const t = layer.type;
  // Narrowed views, the same shape `bgControl` uses for `bg`: a field is only
  // read on the branch whose type actually has it.
  const image = layer.type === "image" ? layer : null;
  const rect = layer.type === "rect" ? layer : null;
  const arrow = layer.type === "arrow" ? layer : null;
  const text = layer.type === "text" ? layer : null;
  const counter = layer.type === "counter" ? layer : null;

  const opacityField = (value) => html`
    <label class="carousel-studio__bg-field">
      <span
        >Opacity:
        <output id="carousel-layer-opacity-out"
          >${String(Math.round(value * 100))}%</output
        ></span
      >
      <input
        type="range"
        id="carousel-layer-opacity"
        min="0"
        max="1"
        step="0.01"
        value="${String(value)}"
      />
    </label>`;

  const colorField = (id, value) => html`
    <label class="carousel-studio__bg-field">
      <span>Colour</span>
      <input type="color" id="${id}" value="${colorInputValue(value)}" />
    </label>`;

  const typeStyleFields = (l) => html`
    ${colorField("carousel-layer-color", l.color)}
    <label class="carousel-studio__bg-field">
      <span>Align</span>
      <select id="carousel-layer-align">
        ${LAYER_ALIGNS.map(
          ([v, label]) => html`
            <option value="${v}" ${v === l.align ? "selected" : ""}>${label}</option>`,
        )}
      </select>
    </label>
    <label class="carousel-studio__bg-field">
      <span>Vertical</span>
      <select id="carousel-layer-valign">
        ${LAYER_VALIGNS.map(
          ([v, label]) => html`
            <option value="${v}" ${v === l.valign ? "selected" : ""}>${label}</option>`,
        )}
      </select>
    </label>
    <label class="carousel-studio__bg-field">
      <span
        >Weight:
        <output id="carousel-layer-weight-out">${String(l.weight)}</output></span
      >
      <input
        type="range"
        id="carousel-layer-weight"
        min="100"
        max="900"
        step="50"
        value="${String(l.weight)}"
      />
    </label>
    <label class="carousel-studio__bg-field carousel-studio__bg-field--check">
      <input type="checkbox" id="carousel-layer-shadow" ${l.shadow ? "checked" : ""} />
      <span>Drop shadow</span>
    </label>`;

  const imageName = image
    ? image.source
      ? image.source.split("/").pop()
      : logoUrl
        ? "site logo (default)"
        : "none picked"
    : "";

  /** @type {import('../../../utils/helpers.js').Slot} */
  let body = "";
  if (text) {
    body = html`
      <label class="carousel-studio__bg-field carousel-studio__bg-field--wide">
        <span>Text</span>
        <textarea id="carousel-layer-text" rows="2">${text.text || ""}</textarea>
      </label>
      ${typeStyleFields(text)}`;
  } else if (counter) {
    body = html`
      <label class="carousel-studio__bg-field">
        <span>Format</span>
        <input type="text" id="carousel-layer-format" value="${counter.format}" />
      </label>
      ${typeStyleFields(counter)}`;
  } else if (image) {
    body = html`
      <div class="carousel-studio__bg-field">
        <span>Source</span>
        <button type="button" class="btn btn-secondary" data-action="layer-pick-image">
          Choose image
        </button>
        <span class="carousel-studio__fit-dims">${imageName}</span>
      </div>
      <label class="carousel-studio__bg-field">
        <span>Fit</span>
        <select id="carousel-layer-fit">
          <option value="contain" ${image.fit === "contain" ? "selected" : ""}>Contain</option>
          <option value="cover" ${image.fit === "cover" ? "selected" : ""}>Cover</option>
        </select>
      </label>
      ${opacityField(image.opacity)}`;
  } else if (rect) {
    body = html`
      <label class="carousel-studio__bg-field">
        <span>Fill</span>
        <input type="color" id="carousel-layer-fill" value="${colorInputValue(rect.fill)}" />
      </label>
      <label class="carousel-studio__bg-field">
        <span
          >Corner:
          <output id="carousel-layer-radius-out"
            >${String(Math.round(rect.radius * 100))}%</output
          ></span
        >
        <input
          type="range"
          id="carousel-layer-radius"
          min="0"
          max="0.5"
          step="0.01"
          value="${String(rect.radius)}"
        />
      </label>
      ${opacityField(rect.opacity)}`;
  } else if (arrow) {
    body = html`
      <label class="carousel-studio__bg-field">
        <span>Direction</span>
        <select id="carousel-layer-direction">
          <option value="right" ${arrow.direction === "right" ? "selected" : ""}>Right</option>
          <option value="left" ${arrow.direction === "left" ? "selected" : ""}>Left</option>
        </select>
      </label>
      ${colorField("carousel-layer-color", arrow.color)} ${opacityField(arrow.opacity)}`;
  }

  return html`<div class="carousel-studio__layer-form" data-layer-type="${t}">${body}</div>`;
}

/**
 * The panorama stage's vertical-anchor rail: a track down the stage's left edge
 * with a thumb at `anchorY` and the percentage beside it.
 *
 * Drawn only when the crop leaves vertical slack (`report.trimmedH > 1`) — the
 * same condition the slider in `fitPanel` appears under, because they are two
 * faces of one control. `aria-hidden`, deliberately: the slider is the labelled
 * assistive path, and a second announced copy of the same number would only be
 * noise. `paintAnchorRail` (`studio/preview.js`) moves it during a drag; the
 * stylesheet fades it in with the stage's `is-anchoring` class.
 *
 * @param {{doc: import('../document.js').CarouselDoc, srcW: number|null,
 *   srcH: number|null}} o
 */
export function anchorRail({ doc, srcW, srcH }) {
  if (!srcW || !srcH || doc.mode === "deck") return "";
  const report = fitReport(
    srcW,
    srcH,
    doc.slides.length,
    doc.aspect,
    /** @type {'cover'|'exact'|'pad'} */ (doc.strategy),
  );
  if (!(report.trimmedH > 1)) return "";
  const pos = Math.min(100, Math.max(0, doc.anchorY * 100));
  return html`
    <div
      class="carousel-studio__anchor-rail"
      aria-hidden="true"
      style="--carousel-anchor-pos:${String(pos)}%"
    >
      <span class="carousel-studio__anchor-thumb">
        <output class="carousel-studio__anchor-readout">${String(Math.round(pos))}%</output>
      </span>
    </div>`;
}

/**
 * The fit panel: source dimensions, one-click count/strategy chips, the
 * strategy radio, a live `fitReport` readout for the current selection, an
 * upscale warning, and a vertical-anchor slider that appears only when the
 * crop leaves vertical slack. Hidden entirely until the source pixel size is
 * known (a probe may still be in flight, or have failed).
 *
 * The slider is the keyboard and assistive path, not the primary one: a
 * left-to-right control for an up-and-down quantity is the wrong gesture, so
 * the band itself is dragged on the stage (`anchorRail` above,
 * `createAnchorGesture` in `studio/gestures.js`) and the two write the same
 * field through the same `_setSplit({ anchorY })`.
 *
 * @param {{doc: import('../document.js').CarouselDoc, srcW: number|null,
 *   srcH: number|null, fitMode: string}} o
 */
export function fitPanel({ doc, srcW, srcH, fitMode }) {
  const { anchorY } = doc;
  const n = doc.slides.length;
  const strategy = /** @type {'cover'|'exact'|'pad'} */ (doc.strategy);
  if (!srcW || !srcH) return "";

  const [dstW, dstH] = canvasSize(doc.aspect);
  const report = fitReport(srcW, srcH, n, doc.aspect, strategy);
  const chips = slideCountOptions(srcW, srcH, doc.aspect, {
    min: MIN_SLIDES,
    max: MAX_SLIDES,
  });

  const scaleTxt =
    Math.abs(report.scale - 1) < 0.005
      ? "pixel-exact"
      : `${(report.scale * 100).toFixed(1)}% scale`;
  const tail =
    report.padPx > 0 ? `${Math.round(report.padPx)} px padding` : "full bleed";
  const readout = [
    `${report.n} ${report.n === 1 ? "slide" : "slides"}`,
    scaleTxt,
    `${Math.round(report.trimmedW)} px trimmed`,
    tail,
  ].join(" · ");

  return html`
    <div class="carousel-studio__fit">
      <p class="carousel-studio__fit-dims">
        Source ${String(srcW)} × ${String(srcH)} · slide ${String(dstW)} ×
        ${String(dstH)} · ${(srcW / dstW).toFixed(2)} slides
      </p>

      <div
        class="carousel-studio__fit-chips"
        role="group"
        aria-label="Suggested slide counts"
      >
        ${chips.map((c) => {
          const label = `${c.n} ${c.strategy === "cover" ? "fill" : c.strategy}`;
          const active = c.n === n && c.strategy === strategy;
          return html`
            <button
              type="button"
              class="carousel-studio__chip ${active ? "is-active" : ""}"
              data-action="fit-chip"
              data-n="${String(c.n)}"
              data-strategy="${c.strategy}"
              title="${c.label}"
            >
              ${label}
            </button>`;
        })}
      </div>

      <fieldset class="carousel-studio__fit-modes">
        <legend>Fit</legend>
        ${FIT_MODES.map(
          ([val, text]) => html`
            <label class="carousel-studio__fit-mode">
              <input
                type="radio"
                name="carousel-fit"
                value="${val}"
                data-action="fit-mode"
                ${val === fitMode ? "checked" : ""}
              />
              <span>${text}</span>
            </label>`,
        )}
      </fieldset>

      <p class="carousel-studio__fit-readout" aria-live="polite">${readout}</p>
      ${report.scale > 1.02
        ? html`<p class="carousel-studio__fit-warning" role="status">
            warning: upscaling — slides will be soft
          </p>`
        : ""}
      ${report.trimmedH > 1
        ? html`
            <label class="carousel-studio__control carousel-studio__control--anchor">
              <span
                >Vertical anchor:
                <output id="carousel-anchor-out"
                  >${String(Math.round(anchorY * 100))}%</output
                ></span
              >
              <input
                type="range"
                id="carousel-anchor"
                min="0"
                max="1"
                step="0.01"
                value="${String(anchorY)}"
              />
              <span class="carousel-studio__hint"
                >Or drag the band up and down on the stage.</span
              >
            </label>`
        : ""}
    </div>`;
}
