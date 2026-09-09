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
import { REFRESH_SVG } from "../../../utils/icons.js";
import { canvasSize, fitReport, safeAreaRect, slideCountOptions } from "../geometry.js";
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
 * The header actions: back, the render button and its progress, the dirty
 * badge, and Remove once a carousel exists.
 *
 * @param {{busy: boolean, renderProgress: {done: number, total: number}|null,
 *   hasCarousel: boolean, dirty: boolean, hasSource: boolean}} o
 */
export function actionsBar({ busy, renderProgress, hasCarousel, dirty, hasSource }) {
  const label = busy
    ? renderProgress
      ? `Rendering… ${renderProgress.done}/${renderProgress.total}`
      : "Rendering…"
    : "Render";
  return html`
    <button class="btn btn-secondary" data-action="back-to-post">&larr; Back to post</button>
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
 * @param {string[]} o.renderedPaths
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
  renderedPaths,
}) {
  const deck = doc.mode === "deck";
  const n = doc.slides.length;
  const [w, h] = canvasSize(doc.aspect);

  const dividers = Array.from({ length: n - 1 }, (_, i) => {
    const left = ((i + 1) / n) * 100;
    return html`<span class="carousel-studio__divider" style="left:${String(left)}%"></span>`;
  });

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
  // deck — it is n independently framed slides laid side by side, which is
  // exactly the continuity check the user now needs.
  const stageSlides = deck
    ? doc.slides.map(
        (_, i) => html`
          <span
            class="carousel-studio__stage-slide"
            data-slice="${String(i)}"
            style="left:${String((i / n) * 100)}%;width:${String(100 / n)}%"
          >
            ${deckLayers()}
          </span>`,
      )
    : "";

  const strip = doc.slides.map((_, i) =>
    deck
      ? html`
          <div
            class="carousel-studio__frame carousel-studio__frame--deck ${i === selected
              ? "is-selected"
              : ""}"
            data-slice="${String(i)}"
            tabindex="0"
            role="group"
            aria-label="Slide ${String(i + 1)} framing — drag to pan, wheel to zoom, arrow keys to nudge"
            style="aspect-ratio:${String(w)}/${String(h)}"
          >
            ${deckLayers()}
          </div>`
      : html`
          <div
            class="carousel-studio__frame"
            data-slice="${String(i)}"
            style="aspect-ratio:${String(w)}/${String(h)}"
          ></div>`,
  );

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
    <div class="carousel-studio__builder">
      ${modeToggle({ mode: doc.mode, canDeck: Boolean(srcW && srcH), busy })}

      <div
        class="carousel-studio__stage ${deck ? "carousel-studio__stage--deck" : ""}"
        style="aspect-ratio:${String(n * w)}/${String(h)}"
      >
        ${stageSlides}${dividers}${guides}
      </div>

      <div class="carousel-studio__filmstrip" aria-label="Slide preview">${strip}</div>

      ${deck
        ? deckPanel({ doc, index: deckIndex, hasPad })
        : fitPanel({ doc, srcW, srcH, fitMode })}

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

        <button class="btn btn-secondary" data-action="pick-source">Change image</button>
      </div>

      ${renderedStrip}
    </div>`;
}

/** Split / Deck. Deck is unavailable until the source pixel size is known —
 *  there would be nothing to derive the per-slide crops from.
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
        title="One image sliced into continuous columns"
      >
        Split
      </button>
      <button
        type="button"
        class="carousel-studio__chip ${mode === "deck" ? "is-active" : ""}"
        data-action="mode"
        data-mode="deck"
        aria-pressed="${mode === "deck" ? "true" : "false"}"
        ${busy || !canDeck ? "disabled" : ""}
        title="${canDeck
          ? "Frame each slide on its own — nothing moves when you switch"
          : "Waiting for the source dimensions"}"
      >
        Deck
      </button>
      <span class="carousel-studio__mode-hint">
        ${mode === "deck"
          ? "Each slide is framed on its own. Going back to Split discards that."
          : "Every slide is a column of one strip."}
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

/**
 * The fit panel: source dimensions, one-click count/strategy chips, the
 * strategy radio, a live `fitReport` readout for the current selection, an
 * upscale warning, and a vertical-anchor slider that appears only when the
 * crop leaves vertical slack. Hidden entirely until the source pixel size is
 * known (a probe may still be in flight, or have failed).
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
            <label class="carousel-studio__control">
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
            </label>`
        : ""}
    </div>`;
}
