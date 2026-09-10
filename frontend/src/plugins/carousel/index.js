/**
 * Carousel Studio — the admin slide-builder shell.
 *
 * Route: /light/carousel?post=<id>. The path carries no `:id` because plugin
 * admin routes are merged verbatim from the manifest and filtered on the
 * `/light` prefix, and the page title is derived from the last path segment
 * (frontend/src/app.js) — a `:postId` segment would title the page ":postId".
 * The target post arrives as a query param instead.
 *
 * Two framing modes over one document. `split` (S1) slices ONE source into `n`
 * continuity-matched columns, every slide a slave of the doc-level `strategy` +
 * `anchorY`. `deck` (S2) freezes that projection into per-slide `crop` + `fit`
 * the user can then pan, zoom and letterbox one slide at a time.
 *
 * This file is UI only. It holds a `CarouselDoc` as its state and mutates it
 * exclusively through `document.js` (`splitDocument`, `toDeckDocument`,
 * `updateSlideFraming`), which clamp and normalize — there is no parallel
 * control state to reconcile back into a document later, and a gesture cannot
 * leave the preview and the renderer disagreeing. The heavy lifting is split
 * three ways —
 *   - `geometry.js`  the pure math (strip crop, column rects, deck crops, and
 *                    the CSS pair that reproduces each in the DOM)
 *   - `render.js`    the thin draw layer (decode → drawImage → encode → upload)
 *   - `document.js`  the carousel document + its `:::{.carousel-block}` output
 * — and the studio's own three halves live under `studio/`:
 *   - `studio/panels.js`    the markup, as pure functions of what they are given
 *   - `studio/preview.js`   the CSS writers that put a crop on screen
 *   - `studio/gestures.js`  deck-mode drag / pinch / wheel / arrow keys
 *   - `studio/history.js`   the undo/redo ring over that document
 * What is left here is the Component: the route, the lifecycle, the actions
 * map, and the one document every one of those modules is handed a piece of.
 * Layers and templates land in later stages (see docs/features/carousel-studio.md).
 *
 * Live preview is CSS, never canvas: a pan or a zoom writes
 * `background-size`/`background-position` from `deckSlideFitCSS` straight onto
 * the frame's image element and commits to the document only when the gesture
 * ends, so dragging costs no decode and no re-render. A slide's background fill
 * is CSS too — a layer behind that image element, mirroring the pad fill
 * `paintSlide` paints — so the filmstrip shows the letterbox the JPEG will
 * carry rather than a placeholder.
 */

import { Component } from "../../components/Component.js";
import {
  adminLayoutTemplate,
  setupAdminLayout,
} from "../../components/light/AdminLayout.js";
import { MediaPickerDialog } from "../../components/light/MediaPickerDialog.js";
import { getPost, updatePost } from "../../api/posts.js";
import { deleteMedia } from "../../api/media.js";
import { deleteCarousel, getCarousel, saveCarousel } from "../../api/carousel.js";
import { getSettings, setToast } from "../../store.js";
import { showConfirm } from "../../utils/dialogs.js";
import { html, navigate } from "../../utils/helpers.js";
import { attachPointerReorder } from "../../utils/pointerReorder.js";
import { canvasSize, deckSlideRects, fitReport, padRects, safeAreaRect } from "./geometry.js";
import {
  addLayer,
  addSlide,
  applyCarouselBlock,
  duplicateSlide,
  emptyDocument,
  moveSlide,
  normalizeDocument,
  parseDocument,
  removeLayer,
  removeSlide,
  reorderLayer,
  serializeDocument,
  SPAN_SLIDE,
  specHash,
  splitDocument,
  toDeckDocument,
  updateLayer,
  updateSlideFraming,
} from "./document.js";
import { browserDeps, renderAndUpload } from "./render.js";
import { DEFAULT_SLIDES, MAX_SLIDES, MIN_SLIDES, clampSlides } from "./studio/bounds.js";
import {
  PROPS_PREF_KEY,
  ZOOM_STEP,
  clampZoom,
  readPropsPref,
} from "./studio/layout.js";
import { actionsBar, builder, pickPrompt } from "./studio/panels.js";
import {
  paintAnchorRail,
  paintDeckLayers,
  paintDeckSlide,
  paintLayerChrome,
  paintSpanChrome,
  paintSpanLayers,
  paintSplit,
} from "./studio/preview.js";
import { createAnchorGesture, createDeckGestures } from "./studio/gestures.js";
import { createHistory } from "./studio/history.js";

/** What a background chip writes, given the type. Bare defaults: the colour and
 *  angle inputs then edit them, and `normalizeBg` is the only clamp. */
const BG_PRESETS = {
  blur: null,
  solid: { type: "solid", color: "#000000" },
  gradient: {
    type: "gradient",
    angle: 180,
    stops: [
      { at: 0, color: "#000000" },
      { at: 1, color: "#2b2b2b" },
    ],
  },
};

/** The post id from `?post=`, or null when absent/malformed. */
function readPostId(query) {
  const raw = /** @type {{ post?: string }} */ (query || {}).post;
  return raw != null && /^[0-9]+$/.test(String(raw)) ? Number(raw) : null;
}

/** Does `el` own the keystroke? A text entry keeps its own undo stack — inside
 *  one, Ctrl+Z is the browser's, and it is the only thing that can put a
 *  half-typed caption back (the studio never sees the keystrokes that built it,
 *  since the form commits on `change`). */
function isTextEntry(el) {
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || Boolean(el?.isContentEditable);
}

/** A picked media item is usable as a split source only if it is an image. */
function isImagePath(path) {
  return typeof path === "string" && !/\.(mp4|mov|webm|m4v|avi)$/i.test(path);
}

/** The `rendered` blocks of a document's slides that actually carry a path. */
function renderedBlocks(doc) {
  return doc.slides.map((s) => s.rendered).filter((r) => r && r.path);
}

/** One slide's spec hash under its document's framing — the doc-level fields
 *  are folded in, so a strategy or anchor change invalidates every slide. */
function slideSpecHash(doc, slide) {
  return specHash(slide, doc.aspect, {
    strategy: doc.strategy,
    anchorY: doc.anchorY,
    spanLayers: doc.spanLayers,
  });
}

/**
 * The media rows this render can reuse instead of re-encoding, one entry per
 * slide (null where there is nothing to reuse).
 *
 * A slide whose specHash still matches the one stored with its render has
 * identical inputs (source/crop/fit/bg, plus the doc-level framing folded in) —
 * reuse its media row rather than re-encode and re-upload it. In deck mode that
 * is what makes nudging one slide re-upload exactly one.
 */
function reusableMedia(doc) {
  return doc.slides.map((slide) => {
    const prior = slide.rendered;
    if (!prior || !Number.isFinite(prior.media_id)) return null;
    return slideSpecHash(doc, slide) === prior.specHash
      ? { id: prior.media_id, path: prior.path }
      : null;
  });
}

/**
 * Byte-identical slides dedup to one media row server-side (SHA256), so two
 * slides would share a path — which the blog renders twice but Instagram
 * (ExtractMediaPaths dedups) renders once. Rather than let the two disagree,
 * forbid it here. See docs/features/carousel-studio.md.
 */
function assertDistinctMedia(media) {
  if (new Set(media.map((m) => m.id)).size !== media.length) {
    throw new Error(
      "Two slides came out byte-identical — change the slide count, the aspect or one slide's framing so every slide is distinct.",
    );
  }
}

/** The document as it stands once `media` has been uploaded for it: every slide
 *  carries the row it rendered to, plus the hash that lets the next render skip
 *  it. */
function documentWithRenders(doc, media) {
  return normalizeDocument({
    ...doc,
    slides: doc.slides.map((slide, i) => ({
      ...slide,
      rendered: {
        path: media[i].path,
        media_id: media[i].id,
        specHash: slideSpecHash(doc, slide),
      },
    })),
  });
}

export default class CarouselStudioPage extends Component {
  /**
   * @param {HTMLElement} container
   * @param {object} [props]  `query.post` carries the target post id;
   *   `renderDeps` overrides the browser render backend (tests inject a fake).
   */
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      postId: readPostId(this.props.query),
      loading: true,
      error: null,
      post: null,
      // The document IS the state. Everything the user can change about the
      // slides lives here and nowhere else.
      doc: emptyDocument(),
      // The *document's* source pixel size — the panorama's photo, and the
      // answer for any slide with no probe of its own. Re-probed on load and on
      // every change to it: derived data, so it is never a document field.
      srcW: null,
      srcH: null,
      // Pixel size per source path, for the slides that name their own photo.
      // A probe is a decode, and a deck frozen from a panorama names one photo
      // N times, so every probe lands here and no path is measured twice.
      // Read through `_dimsFor`, never directly.
      dims: /** @type {Record<string, {srcW: number, srcH: number}>} */ ({}),
      selected: 0,
      // Which layer the property form is editing, or null. An index into the
      // list `layerScope` names: the selected deck slide's `layers`, or
      // `doc.spanLayers` when `layerScope` is `"span"`. A slide-scoped selection
      // is cleared whenever the slide selection moves (a stale index would edit
      // the wrong layer); a span-scoped one survives, since it is not slide-bound.
      selectedLayer: null,
      layerScope: /** @type {"slide"|"span"} */ ("slide"),
      showGuides: true,
      busy: false,
      renderProgress: null,
      hasCarousel: false,
      // Rail wide, bottom sheet below 64em. Remembered only on a wide viewport
      // — a sheet sitting over the stage always opens closed (see layout.js).
      propsOpen: readPropsPref(),
    };
    // The stage's zoom multiplier. A field, not state: it is applied by writing
    // one custom property on the builder root, so changing it costs no rebuild
    // — but the next render has to emit it, or a rebuild would snap back to 1.
    this._stageZoom = 1;
    this._picker = null;
    // A second media picker, for an `image` layer's source. Kept apart from
    // `_picker` (the slide source) so confirming one cannot swap the other.
    this._layerPicker = null;
    // The `rendered` block of every slide the *saved* document points at — the
    // slides really in the post right now. Two readers: the "Rendered slides"
    // strip, and the cleanup a re-render owes (see _render), which takes only
    // the ones carrying a media_id it can delete.
    this._priorRendered = [];
    // serializeDocument() of the last fully-rendered document, or null before
    // anything has ever been rendered — the dirty-state baseline (see _isDirty).
    // A serialized document, not a five-field spec: per-slide framing has no
    // doc-level control to compare, so a spec would report "clean" after a pan.
    this._renderedDoc = null;
    // Slide index to restore focus to after a keyboard nudge rebuilds the strip.
    this._refocus = null;
    // The same, for the rail's drag handle after a keyboard reorder — a
    // different element, and only one of the two is ever pending.
    this._refocusRail = null;
    // `attachPointerReorder`'s teardown for the rail. Bound once in `mount`,
    // since the util re-queries its containers per gesture and so survives a
    // rebuild; released in `beforeUnmount`.
    this._detachReorder = null;
    // Undo/redo. A ring of `doc` references, not a log of operations — the
    // document is immutable by construction, so the previous state is simply
    // the previous reference (see studio/history.js). Every write goes through
    // `_setDoc`, which is the only thing that pushes onto it.
    this._history = createHistory();
    // Deck direct manipulation, over the stage's own columns — the surface the
    // user is looking at, not the rail's thumbnails. Built once and re-attached
    // per render rather than rebuilt with the columns: a wheel gesture's
    // debounced commit has to outlive the rebuild a neighbouring control can
    // cause mid-burst.
    this._gestures = createDeckGestures({
      dims: (i) => ({
        ...this._dimsFor(this.state.doc.slides[i]),
        aspect: this.state.doc.aspect,
      }),
      slideAt: (i) => this.state.doc.slides[i] || null,
      paint: (i, slide) => this._paintDeckSlide(i, slide),
      commit: (i, crop) => this._setSlideFraming(i, { crop }),
      select: (i) => this._select(i),
      refocus: (i) => {
        this._refocus = i;
      },
      // Layer direct manipulation reuses the same machine over the box field —
      // see studio/gestures.js. `activeLayer` is what routes a press between the
      // two: a layer only takes the pointer when its own layer is selected.
      activeLayer: () => {
        const j = this.state.selectedLayer;
        if (j == null) return null;
        // A span layer's box is fractions of the whole deck, so it is grabbable
        // on every column it reaches and commits against `SPAN_SLIDE` — the
        // `scope` is what tells the gesture which space to run in.
        if (this.state.layerScope === "span") {
          const layer = this.state.doc.spanLayers?.[j];
          return layer ? { i: SPAN_SLIDE, j, box: layer.box, scope: "span" } : null;
        }
        const i = this._selectedIndex();
        const layer = this.state.doc.slides[i]?.layers?.[j];
        return layer ? { i, j, box: layer.box, scope: "slide" } : null;
      },
      safeArea: (scope) => this._safeAreaFor(scope),
      paintLayer: (i, j, box, guides) => this._paintProvisionalLayer(i, j, box, guides),
      commitLayer: (i, j, box) => this._commitLayerBox(i, j, box),
    });
    // Panorama direct manipulation, over the stage itself — the band is one
    // projection across the whole strip, so the whole strip is the surface.
    // Built once and re-attached per render, like the deck's.
    this._anchorGesture = createAnchorGesture({
      metrics: () => this._anchorMetrics(),
      paint: (anchorY) => this._paintAnchor(anchorY),
      commit: (anchorY) => this._setSplit({ anchorY }),
    });
  }

  actions = {
    "back-to-post"() {
      navigate(`/light/posts/${this.state.postId}/edit`);
    },
    // `data-slide`, not `data-slice`: every `[data-slice="i"]` element in the
    // studio is a host the deck painters draw layer nodes into, and a button is
    // not one. The panel's other per-slide controls use `data-slide` for the
    // same reason.
    "pick-source"(_e, el) {
      const slide = el.dataset.slide;
      this._openPicker(slide == null ? null : Number(slide));
    },
    render() {
      this._render();
    },
    "remove-carousel"() {
      this._confirmRemove();
    },
    undo() {
      this._undo();
    },
    redo() {
      this._redo();
    },
    "fit-chip"(_e, el) {
      this._setSplit({
        n: clampSlides(Number(el.dataset.n)),
        strategy: /** @type {'cover'|'exact'|'pad'} */ (el.dataset.strategy),
      });
    },
    "change:fit-mode"(_e, el) {
      this._applyFitMode(/** @type {HTMLInputElement} */ (el).value);
    },
    mode(_e, el) {
      this._setMode(el.dataset.mode);
    },
    "slide-fit"(_e, el) {
      this._setSlideFraming(Number(el.dataset.slide), { fit: el.dataset.fit });
    },
    "slide-bg"(_e, el) {
      const preset = BG_PRESETS[el.dataset.bg];
      this._setSlideFraming(Number(el.dataset.slide), {
        bg: preset ? { ...preset } : null,
      });
    },
    "reset-slide"(_e, el) {
      this._setSlideFraming(Number(el.dataset.slide), {
        crop: { x: 0, y: 0, w: 1, h: 1 },
        fit: "cover",
      });
    },
    "add-layer"(_e, el) {
      this._addLayer(el.dataset.type, el.dataset.scope);
    },
    "select-layer"(_e, el) {
      this._selectLayer(Number(el.dataset.index), el.dataset.scope);
    },
    "layer-raise"(_e, el) {
      const j = Number(el.dataset.index);
      this._reorderLayer(j, j + 1, el.dataset.scope);
    },
    "layer-lower"(_e, el) {
      const j = Number(el.dataset.index);
      this._reorderLayer(j, j - 1, el.dataset.scope);
    },
    "delete-layer"(_e, el) {
      this._removeLayer(Number(el.dataset.index), el.dataset.scope);
    },
    "layer-pick-image"() {
      this._openLayerPicker();
    },
    "toggle-props"() {
      this._toggleProps();
    },
    "close-props"() {
      this._toggleProps(false);
    },
    "stage-zoom"(_e, el) {
      this._zoomStage(el.dataset.zoom);
    },
    "select-slide"(_e, el) {
      this._select(Number(el.dataset.slice));
    },
    "add-slide"(_e, el) {
      this._addSlide(Number(el.dataset.slide));
    },
    "duplicate-slide"(_e, el) {
      this._duplicateSlide(Number(el.dataset.slide));
    },
    "delete-slide"(_e, el) {
      this._removeSlide(Number(el.dataset.slide));
    },
  };

  mount() {
    super.mount();
    this._setupSlideReorder();
    this._load();
  }

  beforeUnmount() {
    this._detachReorder?.();
    this._detachReorder = null;
    this._picker?.destroy();
    this._picker = null;
    this._layerPicker?.destroy();
    this._layerPicker = null;
    this._gestures.destroy();
    this._anchorGesture.destroy();
  }

  // ── Document accessors ────────────────────────────────────────────────────

  /** The document's source: the one photo a panorama is cut from, and slide 0's
   *  in Slides mode, where the other slides may each name their own. It answers
   *  the page-level questions — is there anything to build, what does the fit
   *  panel measure, which probe owns `srcW`/`srcH`. Per-slide questions go
   *  through `_dimsFor` instead. */
  _source() {
    return this.state.doc.slides[0]?.source || "";
  }

  /** The pixel size of one slide's source. The per-path probe cache answers
   *  first; the document-level pair is the fallback, which is the whole answer
   *  for a deck that shares one photo.
   *
   * @param {import('./document.js').CarouselSlide} [slide]
   * @returns {{srcW: number|null, srcH: number|null}}
   */
  _dimsFor(slide) {
    return this.state.dims[slide?.source] || { srcW: this.state.srcW, srcH: this.state.srcH };
  }

  /** The slide the deck panel is editing — the selection, pinned inside the
   *  deck in case it shrank under it. */
  _selectedIndex() {
    return Math.min(this.state.selected, this.state.doc.slides.length - 1);
  }

  /**
   * Whether a deck slide leaves a letterbox for its background to fill — the
   * same question `paintSlide` asks, answered from the same `deckSlideRects`
   * pad, so the control and the preview cannot disagree with the render. False
   * with no source or no source dimensions: there is nothing to fill around.
   *
   * @param {import('./document.js').CarouselSlide} slide
   */
  _hasPad(slide) {
    const { srcW, srcH } = this._dimsFor(slide);
    if (!slide?.source || !srcW || !srcH) return false;
    const { aspect } = this.state.doc;
    const [dstW, dstH] = canvasSize(aspect);
    const rect = deckSlideRects(srcW, srcH, aspect, slide.crop, slide.fit);
    return padRects(rect, dstW, dstH).length > 0;
  }

  /** Paths of the slides the post currently points at — the "Rendered slides"
   *  strip. Read from the saved set rather than from the working document, so
   *  it keeps showing what is really in the post while edits are pending. */
  _renderedPaths() {
    return this._priorRendered.map((r) => r.path);
  }

  async _load() {
    const { postId } = this.state;
    if (!postId) {
      this.setState({ loading: false });
      return;
    }
    try {
      const [post, carousel] = await Promise.all([
        getPost(postId),
        getCarousel(postId).catch((err) => {
          if (err?.status === 404) return null;
          throw err;
        }),
      ]);
      if (this._unmounted) return;
      this._adoptLoaded(post, carousel);
    } catch (err) {
      if (this._unmounted) return;
      this.setState({ loading: false, error: err?.message || "Could not load the post." });
    }
  }

  /** Take a freshly loaded post and its carousel (or null) as the working
   *  state, including the dirty-state baseline: only a document whose every
   *  slide has been rendered is something later edits can be dirty against. */
  _adoptLoaded(post, carousel) {
    const doc = carousel ? parseDocument(carousel.doc) : emptyDocument();
    this._priorRendered = renderedBlocks(doc);
    const fullyRendered = doc.slides.length > 0 && doc.slides.every((s) => s.rendered);
    this._renderedDoc = fullyRendered ? serializeDocument(doc) : null;
    // What was loaded is the floor of the history: there is no edit before it
    // to undo to, and a document from a previous visit is not one either.
    this._history.reset(doc);
    this._setDoc(
      doc,
      {
        loading: false,
        post,
        selected: 0,
        hasCarousel: Boolean(carousel),
      },
      { history: false },
    );
    // The document does not store source pixels — re-probe them so the fit
    // panel has its numbers. The images are cache-warm from the CSS background.
    this._probeSources(doc);
  }

  /**
   * Open the media picker for a slide source. `slice` names the one slide the
   * choice lands on, or null for "every slide" — the studio's original
   * behaviour, still reachable from the controls bar.
   *
   * One dialog either way: the scope rides on the per-call handler
   * `MediaPickerDialog.open` takes, which is what that parameter exists for. A
   * second dialog would be a second thing to keep mounted and in sync.
   *
   * @param {number|null} [slice]
   */
  _openPicker(slice = null) {
    if (!this._picker) {
      this._picker = new MediaPickerDialog({
        onConfirm: (items) => this._applyPickedSource(items, null),
      });
      this._picker.mount();
    }
    this._picker.open(slice == null ? null : (items) => this._applyPickedSource(items, slice));
  }

  /** The first image in a picker result, with the dimensions its media row
   *  carried. The media mapper emits width/height (api/internal/api/mappers.go);
   *  they are null for a pre-dimensions upload, and the bitmap is probed then.
   *
   * @param {Array<{path?: string, width?: number, height?: number}>} items
   * @returns {{path: string, srcW: number|null, srcH: number|null}|null}
   */
  _pickedImage(items) {
    const img = (items || []).find((m) => isImagePath(m?.path));
    if (!img) return null;
    return {
      path: img.path,
      srcW: Number.isFinite(img.width) ? img.width : null,
      srcH: Number.isFinite(img.height) ? img.height : null,
    };
  }

  /**
   * Put a picked image into the document.
   *
   * In Slides mode the slides carry framing the user set by hand, so the source
   * is swapped *under* it — crops are normalized against their source, so they
   * stay valid across a photo of any size — and `slice` decides whether that
   * happens to one slide or to all of them. Panorama has nothing per-slide to
   * lose and only ever has one source, so a new image starts a fresh
   * projection whatever `slice` says.
   *
   * @param {Array<{path?: string, width?: number, height?: number}>} items
   * @param {number|null} slice  the slide to change, or null for every slide
   */
  _applyPickedSource(items, slice) {
    const img = this._pickedImage(items);
    if (!img) return;
    const doc = this.state.doc;
    const deck = doc.mode === "deck" && doc.slides.length > 0;
    const next = deck
      ? normalizeDocument({
          ...doc,
          slides: doc.slides.map((s, i) =>
            slice == null || i === slice ? { ...s, source: img.path } : s,
          ),
        })
      : this._splitDoc({ source: img.path, strategy: "cover", anchorY: 0.5 });

    const patch = {};
    if (img.srcW && img.srcH) {
      patch.dims = { ...this.state.dims, [img.path]: { srcW: img.srcW, srcH: img.srcH } };
    }
    // `srcW`/`srcH` describe the document's own source, so they move only when
    // that is what was replaced. A swap on slide 3 leaves them alone — slide 3
    // is answered for by `dims` from here on.
    if (!deck || slice == null || slice === 0) {
      patch.srcW = img.srcW;
      patch.srcH = img.srcH;
    }
    this._setDoc(next, patch);
    if (!img.srcW || !img.srcH) this._probeSource(img.path);
  }

  /** Make sure every distinct source the document names has been measured —
   *  one slide's dimensions cannot answer for another once a deck carries more
   *  than one photo.
   *
   * @param {import('./document.js').CarouselDoc} doc
   */
  _probeSources(doc) {
    for (const path of new Set((doc.slides || []).map((s) => s.source).filter(Boolean))) {
      this._ensureDims(path);
    }
  }

  /** `_probeSource`, skipping the network for a path already measured — but
   *  still re-seating `srcW`/`srcH` when that path is now the document's
   *  source, which is what an undo across a source change needs.
   *
   * @param {string} path
   */
  _ensureDims(path) {
    const known = this.state.dims[path];
    if (!known) {
      this._probeSource(path);
      return;
    }
    if (this._source() !== path) return;
    if (this.state.srcW === known.srcW && this.state.srcH === known.srcH) return;
    this.setState({ srcW: known.srcW, srcH: known.srcH });
  }

  /** Measure a source image and record it. Fills the per-path `dims` cache, and
   *  `srcW`/`srcH` too when the path is the document's own source. On failure
   *  the fit panel simply stays hidden and the bare slider is used. */
  async _probeSource(path) {
    try {
      const deps = this.props.renderDeps || browserDeps();
      const { w, h } = await deps.probeSize(path);
      if (this._unmounted) return;
      /** @type {Record<string, *>} */
      const patch = {};
      if (w && h) patch.dims = { ...this.state.dims, [path]: { srcW: w, srcH: h } };
      // A slide that is not the document's source repaints off `dims`; setting
      // the pair from it would hand the fit panel another slide's numbers.
      if (this._source() === path) {
        patch.srcW = w || null;
        patch.srcH = h || null;
      }
      if (Object.keys(patch).length) this.setState(patch);
    } catch {
      /* no dimensions — the fit panel falls back to the plain controls */
    }
  }

  // ── Document mutation ─────────────────────────────────────────────────────

  /**
   * The one writer for the document. Every mutator below lands here, and this
   * is the only place a `doc` reaches `setState` — which is what lets undo be a
   * ring of references rather than a set of inverse operations.
   *
   * `patch` carries whatever else moves with the document (the selection, the
   * layer scope); it is merged ahead of `doc`, so a caller cannot smuggle a
   * second document past the history by putting one in there.
   *
   * `history: false` writes without adding a step — for a write that is not an
   * edit the user made. Only `_render` uses it, and it repairs the current
   * entry itself (see below).
   *
   * @param {*} doc  the next document
   * @param {object} [patch]  state to set alongside it
   * @param {{history?: boolean}} [options]
   */
  _setDoc(doc, patch = {}, { history = true } = {}) {
    if (history) this._history.push(doc);
    this.setState({ ...patch, doc });
  }

  /**
   * Step the history and show what it hands back, or do nothing at the end of
   * the ring. The layer selection is dropped: it is an index into a list the
   * other document may not have (or may have differently), and a stale one
   * edits the wrong layer. `_selectedIndex` already pins the slide selection
   * inside whatever deck arrives, so that one can stay.
   *
   * A document restored across a source change needs its pixel dimensions
   * re-probed — they are derived data, deliberately not document fields, so the
   * ring does not carry them. `_probeSources` is cached per path, so stepping
   * back and forth over a swap costs one probe, not one per step.
   *
   * @param {"undo"|"redo"} direction
   */
  _step(direction) {
    if (this.state.busy) return;
    const doc = direction === "undo" ? this._history.undo() : this._history.redo();
    if (!doc) return;
    this._setDoc(doc, { selectedLayer: null }, { history: false });
    this._probeSources(doc);
  }

  _undo() {
    this._step("undo");
  }

  _redo() {
    this._step("redo");
  }

  /**
   * Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, bound on `document` for the life of the
   * render — a page-level shortcut has to work when nothing inside the studio
   * holds focus, which a listener on the container cannot do. A text entry
   * keeps its own (see `isTextEntry`).
   *
   * @param {KeyboardEvent} e
   */
  _onHistoryKey(e) {
    const combo = (e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === "z";
    if (!combo || isTextEntry(/** @type {HTMLElement|null} */ (e.target))) return;
    e.preventDefault();
    if (e.shiftKey) this._redo();
    else this._undo();
  }

  /**
   * Rebuild the split projection with `patch` applied over the current
   * doc-level controls. Each slide's `rendered` block is carried over by index
   * so an unchanged slide still skips its re-encode — its `specHash` simply
   * misses wherever the projection actually moved (see `_render`). The deck's
   * span layers ride along untouched: their box is deck-normalized, so a new
   * slide count re-flows the same headline across the new seams rather than
   * dropping it.
   *
   * @param {{source?: string, n?: number, aspect?: string,
   *   strategy?: 'cover'|'exact'|'pad', anchorY?: number}} patch
   */
  _splitDoc(patch = {}) {
    const doc = this.state.doc;
    const current = doc.slides.length >= MIN_SLIDES ? doc.slides.length : DEFAULT_SLIDES;
    const next = splitDocument({
      source: patch.source ?? this._source(),
      n: patch.n ?? current,
      aspect: patch.aspect ?? doc.aspect,
      strategy: patch.strategy ?? doc.strategy,
      anchorY: patch.anchorY ?? doc.anchorY,
      spanLayers: doc.spanLayers,
    });
    next.slides.forEach((slide, i) => {
      slide.rendered = doc.slides[i]?.rendered ?? null;
    });
    return next;
  }

  /** Apply a doc-level split control. */
  _setSplit(patch) {
    const doc = this._splitDoc(patch);
    this._setDoc(doc, { selected: Math.min(this.state.selected, doc.slides.length - 1) });
  }

  /**
   * Switch framing mode. Split → deck is a freeze: `toDeckDocument` writes each
   * slide the crop `sliceRects` was already deriving for it, so nothing on
   * screen moves. Deck → split throws that per-slide work away — and, once the
   * slides can name their own photos, every source but the first — so the toast
   * says so and carries the way back.
   *
   * The user-facing words for the two modes are **Panorama** and **Slides**
   * (`modeToggle` in `studio/panels.js`); the stored values stay `split` and
   * `deck`, so everything below and every document on disk keeps one vocabulary.
   *
   * @param {string} mode
   */
  _setMode(mode) {
    const doc = this.state.doc;
    if (!mode || mode === doc.mode || this.state.busy || !doc.slides.length) return;

    if (mode === "deck") {
      const { srcW, srcH } = this.state;
      // Without source pixels there is nothing to derive crops from, and the
      // preview would show a projection the render does not agree with.
      if (!srcW || !srcH) return;
      const next = toDeckDocument(doc, srcW, srcH);
      this._setDoc(next, { selected: 0 });
      // The freeze is invisible except for one case: `pad`'s short tail column
      // sat flush left with its gap on the right, and a deck slide can only
      // centre a contained crop. Say so, rather than let the user hunt for what
      // moved (see toDeckDocument in document.js).
      const recentred = next.slides.some((s) => s.fit === "contain");
      setToast({
        message: recentred
          ? "Slides mode — drag a slide to pan, wheel to zoom. The padded slide is now centred, not flush left."
          : "Slides mode — drag a slide to pan, wheel to zoom.",
        type: "success",
      });
      return;
    }

    // No dialog: the switch is a document write like any other, so it is one
    // Ctrl+Z away. A confirm in front of a reversible step asks the user to
    // decide before they can see what it does — the toast tells them after, and
    // carries the way back.
    // A panorama is one photo cut into columns, so a deck of several photos
    // cannot survive the trip — say which one is left rather than let the user
    // find out by counting.
    const shared = new Set(doc.slides.map((slide) => slide.source)).size === 1;
    this._setDoc(this._splitDoc(), { selected: 0 });
    this._undoToast(
      shared
        ? "Back to Panorama — the per-slide pan, zoom and fit are gone."
        : "Back to Panorama — every slide now shows the first slide's photo, and the per-slide pan, zoom and fit are gone.",
    );
  }

  /** The single writer for per-slide framing — every gesture, key and button
   *  lands here, and clamping is `updateSlideFraming`'s job, not the caller's. */
  _setSlideFraming(i, update) {
    const { srcW, srcH } = this._dimsFor(this.state.doc.slides[i]);
    const doc = updateSlideFraming(this.state.doc, i, update, {
      srcW: srcW || 0,
      srcH: srcH || 0,
    });
    this._setDoc(doc, { selected: i });
  }

  /** Select a slide, if that is a change — the deck panel follows the selection,
   *  so this re-renders and must never run mid-gesture. The layer selection is
   *  an index into *this* slide's list, so it cannot survive the move. */
  _select(i) {
    if (this.state.selected === i) return;
    // A slide-scoped layer selection is an index into *this* slide's list, so it
    // cannot survive the move; a span-scoped one is deck-wide and stays put.
    const patch = { selected: i };
    if (this.state.layerScope === "slide") patch.selectedLayer = null;
    this.setState(patch);
  }

  // ── Slides (deck mode) ────────────────────────────────────────────────────
  // Slides mode only. A panorama's slide count is the fit panel's — three
  // controls that all re-derive the whole array from one strip through
  // `splitDocument` — so a rail that could add or drop a column there would be
  // offering to break the derivation. That is what the mode means.
  //
  // Every one of these is a plain document write through `_setDoc`, so it is
  // one Ctrl+Z away; none of them touches the server. A removed slide's media
  // row is deleted by the next render's `_deleteSuperseded`, reading the saved
  // set rather than the document — which is exactly what makes the undo real.

  /**
   * Whether `n` is a slide count the studio will write. Refusing is a toast,
   * not an exception: every caller is a button, the ends are disabled anyway,
   * and the bounds are the user's business rather than a programming error.
   *
   * @param {number} n
   */
  _allowSlideCount(n) {
    if (n < MIN_SLIDES) {
      setToast({ message: `A carousel needs at least ${MIN_SLIDES} slides.`, type: "error" });
      return false;
    }
    if (n > MAX_SLIDES) {
      setToast({ message: `A carousel holds at most ${MAX_SLIDES} slides.`, type: "error" });
      return false;
    }
    return true;
  }

  /** The state patch a change of selected slide owes: a slide-scoped layer
   *  selection is an index into *that* slide's list, so it cannot survive the
   *  move; a span-scoped one is deck-wide and stays. Same rule as `_select`. */
  _selectSlidePatch(i) {
    const patch = { selected: i };
    if (this.state.layerScope === "slide") patch.selectedLayer = null;
    return patch;
  }

  /** The slide a rail control names, or the selection when it names nothing. */
  _slideArg(i) {
    return Number.isInteger(i) ? i : this._selectedIndex();
  }

  /** Add a slide after `i` and select it. It starts on the same photo,
   *  uncropped — `addSlide` decides that; the studio never authors a slide
   *  literal, the same rule layers keep. */
  _addSlide(i) {
    const doc = this.state.doc;
    if (doc.mode !== "deck" || this.state.busy) return;
    if (!this._allowSlideCount(doc.slides.length + 1)) return;
    const at = this._slideArg(i) + 1;
    const next = addSlide(doc, at, null);
    if (next.slides.length === doc.slides.length) return;
    this._setDoc(next, this._selectSlidePatch(at));
  }

  /** Duplicate slide `i`, landing the copy after it and selecting it. The copy
   *  is pixel-for-pixel its twin until something moves, and two byte-identical
   *  slides are what `assertDistinctMedia` refuses — so the toast says what the
   *  copy is for, rather than letting a failed render be the one to explain. */
  _duplicateSlide(i) {
    const doc = this.state.doc;
    if (doc.mode !== "deck" || this.state.busy) return;
    if (!this._allowSlideCount(doc.slides.length + 1)) return;
    const j = this._slideArg(i);
    const next = duplicateSlide(doc, j);
    if (next.slides.length === doc.slides.length) return;
    this._setDoc(next, this._selectSlidePatch(j + 1));
    setToast({
      message: "Slide duplicated — reframe it or give it its own photo; two identical slides cannot render.",
      type: "success",
    });
  }

  /** Drop slide `i`. No confirm — it is a document write, so it is one Ctrl+Z
   *  (or the toast's button) away, and the image it rendered to is still on the
   *  server until the next render says otherwise. */
  _removeSlide(i) {
    const doc = this.state.doc;
    if (doc.mode !== "deck" || this.state.busy) return;
    if (!this._allowSlideCount(doc.slides.length - 1)) return;
    const j = this._slideArg(i);
    const next = removeSlide(doc, j);
    if (next.slides.length === doc.slides.length) return;
    const shifted = this.state.selected > j ? this.state.selected - 1 : this.state.selected;
    this._setDoc(next, this._selectSlidePatch(Math.min(shifted, next.slides.length - 1)));
    this._undoToast("Slide removed — its rendered image goes when you next render.");
  }

  /**
   * Move slide `from` to `to`, keeping the selection on the slide the user was
   * pointing at. A slide carries its own layers, so the layer selection travels
   * with it and needs no clearing. `to` out of range is a no-op — the rail's
   * end controls stop before it, this is the belt-and-braces.
   *
   * `refocus` is for the keyboard path: the write rebuilds the rail out from
   * under the handle the user is holding, so it is claimed *before* the write
   * — `_setDoc` renders synchronously, and a flag set after it would be read
   * by the render after next. The same order `gestures.js` nudges in.
   *
   * @param {number} from
   * @param {number} to
   * @param {{refocus?: boolean}} [opts]
   * @returns {boolean} whether the document moved
   */
  _moveSlide(from, to, { refocus = false } = {}) {
    const doc = this.state.doc;
    if (doc.mode !== "deck" || this.state.busy) return false;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from === to || to < 0 || to >= doc.slides.length) return false;

    let sel = this.state.selected;
    if (sel === from) sel = to;
    else if (sel > from && sel <= to) sel -= 1;
    else if (sel < from && sel >= to) sel += 1;
    if (refocus) this._refocusRail = to;
    this._setDoc(moveSlide(doc, from, to), { selected: sel });
    return true;
  }

  /**
   * Slide reordering on the rail: a pointer drag over the filmstrip, and the
   * arrow keys on the same handle (`_wireControls`). Pointer events rather than
   * HTML5 drag-and-drop — `attachPointerReorder` says why — and the util owns
   * the gesture and nothing else: the drop arrives here as an element and the
   * item it landed after, and becomes a `moveSlide` write like any other.
   *
   * Bound once, for the life of the page. The util re-queries its containers
   * per gesture, so the rebuild every write causes costs it nothing.
   */
  _setupSlideReorder() {
    this._detachReorder?.();
    this._detachReorder = attachPointerReorder({
      handleSelector: ".carousel-studio__rail-handle",
      itemSelector: ".carousel-studio__rail-item",
      containers: () => [this.$(".carousel-studio__filmstrip")],
      axis: "x",
      isEnabled: () => this.state.doc.mode === "deck" && !this.state.busy,
      onDrop: ({ item, afterEl }) => {
        // The rail is in document order, so an item's `data-slide` *is* its
        // index. Landing after a slide further along means taking its place
        // once the drag has vacated its own — hence the +1 on that side only.
        const from = Number(item?.dataset?.slide);
        if (!Number.isInteger(from)) return;
        if (afterEl === item) return;
        const after = afterEl ? Number(afterEl.dataset.slide) : null;
        this._moveSlide(from, after == null ? 0 : after > from ? after : after + 1);
      },
    });
  }

  // ── Layers (deck mode) ────────────────────────────────────────────────────

  /**
   * The `slideIndex` and current list a layer scope addresses: the deck's
   * spanning layers at {@link SPAN_SLIDE}, the selected slide's own otherwise.
   * Every layer mutator routes through this, so one family of `document.js`
   * calls serves both — see `layerPanel` in `studio/panels.js`.
   *
   * @param {"slide"|"span"} scope
   */
  _layerTarget(scope) {
    if (scope === "span") {
      return { slideIndex: SPAN_SLIDE, list: this.state.doc.spanLayers || [] };
    }
    const i = this._selectedIndex();
    return { slideIndex: i, list: this.state.doc.slides[i]?.layers || [] };
  }

  /**
   * A fresh layer of `type`, its box landed inside the slide's `safeAreaRect`
   * (`geometry.js`) rather than at the origin — a layer outside the frame's
   * honest bounds is one the user has to move before it is any use. A `"span"`
   * layer keeps the type's vertical placement but stretches across the deck,
   * since its box is normalized to the whole filmstrip and running across the
   * seams is the use. Only the `box` (and an `image` layer's default source) is
   * set here; every other field is `normalizeLayer`'s to fill, because the
   * studio never authors a layer literal — see `addLayer` in `document.js`.
   *
   * @param {string} type one of `LAYER_TYPES`
   * @param {"slide"|"span"} [scope]
   */
  _defaultLayer(type, scope = "slide") {
    const { aspect } = this.state.doc;
    const [w, h] = canvasSize(aspect);
    const sa = safeAreaRect(aspect);
    const fx = sa.x / w;
    const fy = sa.y / h;
    const fw = sa.w / w;
    const fh = sa.h / h;
    const boxes = {
      text: { x: fx, y: fy + fh * 0.5, w: fw, h: fh * 0.3 },
      counter: { x: fx, y: fy + fh * 0.86, w: fw, h: fh * 0.14 },
      image: { x: fx, y: fy, w: fw * 0.32, h: fh * 0.16 },
      rect: { x: fx, y: fy + fh * 0.45, w: fw, h: fh * 0.4 },
      arrow: { x: fx + fw * 0.82, y: fy + fh * 0.42, w: fw * 0.18, h: fh * 0.16 },
    };
    const box = boxes[type] || { x: fx, y: fy, w: fw, h: fh };
    if (scope === "span") {
      if (type === "image") {
        box.x = 0.44;
        box.w = 0.12;
      } else {
        box.x = 0.06;
        box.w = 0.88;
      }
    }
    const layer = { type, box };
    if (type === "image") {
      const logo = getSettings()?.logo_url;
      if (logo) layer.source = logo;
    }
    return layer;
  }

  /** Add a layer to the scope's list and select it — a new layer lands on top
   *  of the stack (`addLayer` appends), which is the row at the top of the list. */
  _addLayer(type, scope) {
    const s = scope === "span" ? "span" : "slide";
    const { slideIndex } = this._layerTarget(s);
    const doc = addLayer(this.state.doc, slideIndex, this._defaultLayer(type, s));
    const list = s === "span" ? doc.spanLayers : doc.slides[this._selectedIndex()]?.layers || [];
    this._setDoc(doc, {
      layerScope: s,
      selectedLayer: list.length ? list.length - 1 : null,
    });
  }

  _selectLayer(j, scope) {
    const s = scope === "span" ? "span" : "slide";
    if (this.state.layerScope === s && this.state.selectedLayer === j) return;
    this.setState({ layerScope: s, selectedLayer: j });
  }

  /**
   * Move a layer from `from` to `to` in paint order within its scope's list,
   * keeping the selection on whichever layer the user was pointing at when the
   * selection is in that same scope. `to` out of range is a no-op — the list's
   * end buttons are disabled, this is the belt-and-braces.
   */
  _reorderLayer(from, to, scope) {
    const s = scope === "span" ? "span" : "slide";
    const { slideIndex, list } = this._layerTarget(s);
    if (to < 0 || to >= list.length) return;
    const doc = reorderLayer(this.state.doc, slideIndex, from, to);
    const patch = {};
    if (this.state.layerScope === s && this.state.selectedLayer != null) {
      let sel = this.state.selectedLayer;
      if (sel === from) sel = to;
      else if (sel > from && sel <= to) sel -= 1;
      else if (sel < from && sel >= to) sel += 1;
      patch.selectedLayer = sel;
    }
    this._setDoc(doc, patch);
  }

  /** Drop a layer. No confirm — the removal is a document write, so it is one
   *  Ctrl+Z (or one toast button) away; see `_undoToast`. */
  _removeLayer(j, scope) {
    const s = scope === "span" ? "span" : "slide";
    const { slideIndex } = this._layerTarget(s);
    const doc = removeLayer(this.state.doc, slideIndex, j);
    const patch = {};
    if (this.state.layerScope === s) {
      let sel = this.state.selectedLayer;
      if (sel === j) sel = null;
      else if (sel != null && sel > j) sel -= 1;
      patch.selectedLayer = sel;
    }
    this._setDoc(doc, patch);
    this._undoToast(s === "span" ? "Layer removed from the deck." : "Layer removed from the slide.");
  }

  /** The single writer for a layer's fields — every property-form commit lands
   *  here, and clamping/normalizing is `updateLayer`'s job, not the caller's. */
  _setLayer(patch) {
    const j = this.state.selectedLayer;
    if (j == null) return;
    const { slideIndex } = this._layerTarget(this.state.layerScope);
    this._setDoc(updateLayer(this.state.doc, slideIndex, j, patch));
  }

  /** The safe-area rect to snap a layer against, in the fractions of the space
   *  that layer's box lives in. A slide layer gets the slide's own. A span
   *  layer gets the *deck's*: vertically the same band, horizontally the left
   *  inset of the first slide to the right inset of the last, so a headline
   *  snaps to the margins that actually cut it off rather than to a seam it is
   *  meant to cross (the seams are guides in their own right — `deckSeams`).
   *
   * @param {"slide"|"span"} [scope]
   */
  _safeAreaFor(scope) {
    const { aspect } = this.state.doc;
    const [w, h] = canvasSize(aspect);
    const sa = safeAreaRect(aspect);
    const rect = { x: sa.x / w, y: sa.y / h, w: sa.w / w, h: sa.h / h };
    if (scope !== "span") return rect;
    // Left edge: slide 0's inset, in deck fractions. Right edge: slide n-1's,
    // which is `n - 1` whole slides along. The width is the difference.
    const n = Math.max(1, this.state.doc.slides.length);
    return { x: rect.x / n, y: rect.y, w: (n - 1 + rect.w) / n, h: rect.h };
  }

  /** The commit point for a drag or a keyboard nudge of a layer's box — the
   *  gesture's twin of `_setSlideFraming`. `i` is `SPAN_SLIDE` for a deck-wide
   *  layer, whose selection is not slide-bound and so must not move the slide
   *  selection with it. `updateLayer` re-clamps the box, so the gesture's own
   *  clamp is only for preview smoothness. */
  _commitLayerBox(i, j, box) {
    const doc = updateLayer(this.state.doc, i, j, { box });
    this._setDoc(
      doc,
      i === SPAN_SLIDE
        ? { layerScope: "span", selectedLayer: j }
        : { selected: i, layerScope: "slide", selectedLayer: j },
    );
  }

  /** The selected slide index, the `slideIndex` its layer scope addresses, the
   *  scope, the selected layer index and that layer (or null) — everything a
   *  layer-field handler needs. */
  _selectedLayerRef() {
    const scope = this.state.layerScope;
    const { slideIndex, list } = this._layerTarget(scope);
    const j = this.state.selectedLayer;
    const layer = j == null ? null : list[j] || null;
    return { i: this._selectedIndex(), slideIndex, scope, j, layer };
  }

  _openLayerPicker() {
    if (this.state.selectedLayer == null) return;
    if (!this._layerPicker) {
      this._layerPicker = new MediaPickerDialog({
        onConfirm: (items) => {
          const img = (items || []).find((m) => isImagePath(m?.path));
          if (img) this._setLayer({ source: img.path });
        },
      });
      this._layerPicker.mount();
    }
    this._layerPicker.open();
  }

  /**
   * Apply a fit-panel radio choice: `cover` keeps the current count; `fill`,
   * `exact` and `pad` each snap the count to what the strategy makes from this
   * source (`ceil`/`floor` of `srcW / slideW`), clamped to the studio bounds.
   *
   * @param {string} mode  one of the fit panel's modes
   */
  _applyFitMode(mode) {
    const { srcW } = this.state;
    const doc = this.state.doc;
    const [dstW] = canvasSize(doc.aspect);
    const n = doc.slides.length;
    const ceilN = srcW ? clampSlides(Math.ceil(srcW / dstW)) : n;
    const floorN = srcW ? clampSlides(Math.floor(srcW / dstW)) : n;
    if (mode === "exact") this._setSplit({ strategy: "exact", n: floorN });
    else if (mode === "pad") this._setSplit({ strategy: "pad", n: ceilN });
    else if (mode === "fill") this._setSplit({ strategy: "cover", n: ceilN });
    else this._setSplit({ strategy: "cover" });
  }

  /** Which fit radio the current document reads as. `cover` at exactly the
   *  width-filling count is shown as `fill`; the two are otherwise identical. */
  _currentFitMode() {
    const { srcW } = this.state;
    const { strategy, aspect, slides } = this.state.doc;
    if (strategy === "exact" || strategy === "pad") return strategy;
    const [dstW] = canvasSize(aspect);
    if (srcW && slides.length === clampSlides(Math.ceil(srcW / dstW))) return "fill";
    return "cover";
  }

  /** The full post payload — a partial PUT would wipe unsent fields (excerpt,
   *  css, tags, meta_description…), so re-send everything the load gave us. */
  _postPayload(post, content) {
    return {
      title: post.title,
      slug: post.slug,
      content,
      css: post.css || "",
      excerpt: post.excerpt || null,
      immersive_mode: post.immersive_mode || "auto",
      instagram_share: post.instagram_share ?? false,
      is_featured: post.is_featured ?? false,
      thumbnail_path: post.thumbnail_path ?? null,
      meta_description: post.meta_description ?? null,
      formatter: post.formatter,
      status: post.status,
      type: post.type,
      tags: (post.tags || []).map((t) => t.name),
    };
  }

  /** Whether the working document disagrees with the last fully-rendered one —
   *  a stale post fence with nothing on screen saying so, absent this check.
   *  `null` before anything has ever been rendered: nothing to be dirty against. */
  _isDirty() {
    if (!this._renderedDoc || !this._source()) return false;
    return serializeDocument(this.state.doc) !== this._renderedDoc;
  }

  // ── Render / save ─────────────────────────────────────────────────────────

  /**
   * Render every slide, put the result in the post, and clean up after the
   * generation it replaced. The phases are one method each below; this is the
   * order they run in and the only place the studio's own state moves.
   */
  async _render() {
    const { postId, post } = this.state;
    const doc = this.state.doc;
    if (!this._source() || !doc.slides.length || this.state.busy) return;
    const total = doc.slides.length;

    this.setState({ busy: true, error: null, renderProgress: { done: 0, total } });
    try {
      const media = await this._uploadSlides(doc, postId);
      assertDistinctMedia(media);

      const next = documentWithRenders(doc, media);
      const finalContent = await this._saveRendered(postId, post, next);
      // Reads `_priorRendered`, so it runs before the new generation replaces it.
      await this._deleteSuperseded(media, finalContent);

      this._priorRendered = renderedBlocks(next);
      this._renderedDoc = serializeDocument(next);

      if (this._unmounted) return;
      // A render is not an edit: it stamps `rendered` blocks onto the document
      // already on screen. So no new step — but the current entry has to carry
      // them, or undoing the *next* edit would land on a document that has to
      // re-encode every slide.
      this._history.replace(next);
      this._setDoc(
        next,
        {
          busy: false,
          renderProgress: null,
          hasCarousel: true,
          post: { ...post, content: finalContent },
        },
        { history: false },
      );
      setToast({ message: `Carousel rendered — ${media.length} slides.`, type: "success" });
    } catch (err) {
      if (this._unmounted) return;
      this.setState({ busy: false, renderProgress: null, error: err?.message || "Render failed." });
      setToast({ message: `Carousel render failed: ${err?.message || err}`, type: "error" });
    }
  }

  /** Draw and upload the slides this render owes, reusing every media row whose
   *  inputs have not moved, and reporting progress as they land. */
  _uploadSlides(doc, postId) {
    const { srcW, srcH } = this.state;
    const deps = this.props.renderDeps || browserDeps();
    return renderAndUpload(
      { doc, postId, srcW: srcW || undefined, srcH: srcH || undefined },
      deps,
      (p) => {
        if (!this._unmounted) this.setState({ renderProgress: p });
      },
      reusableMedia(doc),
    );
  }

  /** Save the rendered document and write its block into the post. Returns the
   *  post content as it ended up — the server's copy where it sent one back. */
  async _saveRendered(postId, post, doc) {
    await saveCarousel(postId, doc);
    const content = applyCarouselBlock(post.content, doc);
    const updated = await updatePost(postId, this._postPayload(post, content));
    return updated?.content ?? content;
  }

  /**
   * The previous generation's slides are now unreferenced: orphan detection
   * keys on `post_id IS NULL` and these carry a post_id, so they would sit on
   * disk forever. Delete each superseded row explicitly — but never one whose
   * path still appears in the post (a slide reused inline, say), and never one
   * this render just reused.
   */
  async _deleteSuperseded(media, finalContent) {
    const keptIds = new Set(media.map((m) => m.id));
    const superseded = this._priorRendered.filter(
      (r) =>
        Number.isFinite(r.media_id) &&
        !keptIds.has(r.media_id) &&
        !finalContent.includes(r.path),
    );
    if (superseded.length) {
      await Promise.allSettled(superseded.map((r) => deleteMedia(r.media_id)));
    }
  }

  /** Imperative confirm/prompt plumbing, broken out so a test can override it
   *  without touching the DOM (see PostEditPage's `_showConfirm` for the same
   *  pattern). */
  _showConfirm(title, message, confirmText, variant, onConfirm) {
    showConfirm({ title, message, confirmText, variant, onConfirm });
  }

  /** Report a step that used to ask permission first, and offer the way back.
   *  Everything it fronts is a document write, so "the way back" is exactly one
   *  history step — the same one Ctrl+Z takes. */
  _undoToast(message) {
    setToast({
      message,
      type: "success",
      action: { label: "Undo", onAction: () => this._undo() },
    });
  }

  _confirmRemove() {
    this._showConfirm(
      "Remove carousel",
      "Delete this carousel? Its slides are removed from the post and their media deleted. This cannot be undone.",
      "Remove",
      "danger",
      () => this._removeCarousel(),
    );
  }

  async _removeCarousel() {
    const { postId, post } = this.state;
    if (!postId || !post || this.state.busy) return;

    this.setState({ busy: true, error: null });
    try {
      await deleteCarousel(postId);
      const content = applyCarouselBlock(post.content, emptyDocument());
      const updated = await updatePost(postId, this._postPayload(post, content));
      const finalContent = updated?.content ?? content;

      const toDelete = this._priorRendered.filter((r) => r.media_id);
      if (toDelete.length) {
        await Promise.allSettled(toDelete.map((r) => deleteMedia(r.media_id)));
      }
      this._priorRendered = [];
      this._renderedDoc = null;

      if (this._unmounted) return;
      // Undo cannot reach this — the media rows are gone from the server, not
      // just from the document — so the history starts over rather than
      // offering a way back to slides that no longer exist.
      const empty = emptyDocument();
      this._history.reset(empty);
      this._setDoc(
        empty,
        {
          busy: false,
          post: { ...post, content: finalContent },
          srcW: null,
          srcH: null,
          selected: 0,
          selectedLayer: null,
          hasCarousel: false,
        },
        { history: false },
      );
      setToast({ message: "Carousel removed.", type: "success" });
    } catch (err) {
      if (this._unmounted) return;
      this.setState({ busy: false, error: err?.message || "Could not remove carousel." });
      setToast({ message: `Remove failed: ${err?.message || err}`, type: "error" });
    }
  }

  // ── Markup ────────────────────────────────────────────────────────────────

  render() {
    const { postId, post, loading } = this.state;
    if (!postId) {
      return adminLayoutTemplate({
        title: "Carousel Studio",
        content: html`
          <section class="carousel-studio carousel-studio--empty">
            <p class="empty-state">
              Open the studio from a post's editor menu — it needs a post to
              build slides for.
            </p>
          </section>`,
      });
    }

    // The post-title crumb is left out rather than filled with a placeholder
    // — a placeholder swapping to the real title once the post loads reads
    // as a jump, not a fill-in.
    const postCrumb = post?.title || (loading ? null : "Untitled");
    return adminLayoutTemplate({
      breadcrumbs: [
        { label: "Posts", href: "/light/posts" },
        ...(postCrumb ? [{ label: postCrumb, href: `/light/posts/${postId}/edit` }] : []),
        { label: "Carousel Studio" },
      ],
      actions: actionsBar({
        busy: this.state.busy,
        renderProgress: this.state.renderProgress,
        hasCarousel: this.state.hasCarousel,
        dirty: this._isDirty(),
        hasSource: Boolean(this._source()),
        canUndo: this._history.canUndo,
        canRedo: this._history.canRedo,
      }),
      content: this._renderStudio(),
      // A split stage is n slides wide; the admin content clamp would squeeze
      // it to a band. See `.carousel-studio-full-width` in carousel.css.
      contentClass: "carousel-studio-full-width",
    });
  }

  _renderStudio() {
    const { loading, error, postId } = this.state;

    if (loading) {
      return html`
        <section class="carousel-studio" data-post-id="${String(postId)}">
          <div class="loading-spinner" aria-label="Loading…"></div>
        </section>`;
    }

    return html`
      <section class="carousel-studio" data-post-id="${String(postId)}">
        ${error ? html`<p class="error-state" role="alert">${error}</p>` : ""}
        ${this._source() ? this._renderBuilder() : pickPrompt()}
      </section>`;
  }

  // ── Stage layout ─────────────────────────────────────────────────────────
  // Zoom and the properties panel are viewport state, not document state:
  // both are applied straight to the DOM the way `PostEditPage._toggleDetails`
  // does, so neither costs a rebuild (and a rebuild mid-gesture is exactly what
  // a stage control must not cause). Every render re-emits them from the two
  // fields below, so a rebuild from anywhere else keeps them.

  /** Open, close, or flip the properties panel, and remember the choice. */
  _toggleProps(force) {
    const open = typeof force === "boolean" ? force : !this.state.propsOpen;
    this.state.propsOpen = open;
    this.$(".carousel-studio__builder")?.classList.toggle("is-details-open", open);
    const toggle = this.$("#carousel-props-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide properties" : "Properties";
    }
    this.$("#carousel-props")?.setAttribute("aria-hidden", String(!open));
    try {
      localStorage.setItem(PROPS_PREF_KEY, open ? "1" : "0");
    } catch {
      /* private mode — the panel still works, it just won't be remembered */
    }
  }

  /** One of the four zoom buttons. `fit` is the only one that has to measure. */
  _zoomStage(which) {
    if (which === "fit") return this._fitStageZoom();
    if (which === "reset") return this._setStageZoom(1);
    this._setStageZoom(this._stageZoom * (which === "in" ? ZOOM_STEP : 1 / ZOOM_STEP));
  }

  /** Write the zoom multiplier: one custom property, plus the readout. */
  _setStageZoom(z) {
    this._stageZoom = clampZoom(z);
    this.$(".carousel-studio__builder")?.style?.setProperty(
      "--carousel-stage-zoom",
      String(this._stageZoom),
    );
    const out = this.$("#carousel-zoom-readout");
    if (out) out.textContent = `${Math.round(this._stageZoom * 100)}%`;
  }

  /** The zoom at which the whole strip fits the scroller's width. Measured
   *  rather than derived: the budget is a `clamp()` of `vh`, so only layout
   *  knows what the stage is currently worth in pixels. */
  _fitStageZoom() {
    const scroll = this.$(".carousel-studio__stage-scroll");
    const stage = this.$(".carousel-studio__stage");
    const width = stage?.getBoundingClientRect?.().width || 0;
    const room = scroll?.clientWidth || 0;
    if (!width || !room) return;
    this._setStageZoom((this._stageZoom * room) / width);
  }

  /** Everything the builder markup needs, read off the state in one place —
   *  `studio/panels.js` answers no questions about the page itself. */
  _renderBuilder() {
    const { doc, showGuides, selected, srcW, srcH, busy, selectedLayer, layerScope } = this.state;
    const deckIndex = this._selectedIndex();
    return builder({
      doc,
      showGuides,
      selected,
      deckIndex,
      srcW,
      srcH,
      busy,
      fitMode: this._currentFitMode(),
      hasPad: this._hasPad(doc.slides[deckIndex]),
      selectedLayer,
      layerScope,
      logoUrl: getSettings()?.logo_url || "",
      renderedPaths: this._renderedPaths(),
      propsOpen: this.state.propsOpen,
      stageZoom: this._stageZoom,
    });
  }

  // ── Preview painting ──────────────────────────────────────────────────────

  afterRender() {
    setupAdminLayout(this, { currentPath: "/light/carousel" });

    // Re-taken every render, released with it (see Component's resource
    // contract) — so navigating off the studio takes the shortcut with it.
    this.on(document, "keydown", (e) => this._onHistoryKey(/** @type {KeyboardEvent} */ (e)));

    const deck = this.state.doc.mode === "deck";
    const source = this._source();
    if (source) {
      if (deck) this._paintDeck();
      else this._paintSplit(source);
    }

    this._wireControls();
    this._gestures.attach(deck ? this.$$(".carousel-studio__stage-slide") : []);
    // The panorama stage takes the pointer only when it is the surface — and
    // only when `panels.js` emitted a rail, which is its answer to whether the
    // crop leaves any slack to drag through.
    this._anchorGesture.attach(
      deck ? null : this.$(".carousel-studio__stage--anchor"),
    );

    // The selected layer's chrome (outline + handles) is markup; position it
    // now that the columns exist. Cleared for free when nothing is selected —
    // panels.js emits the chrome node only then.
    if (deck && this.state.selectedLayer != null) {
      const j = this.state.selectedLayer;
      if (this.state.layerScope === "span") {
        this._paintSpanChrome(this.state.doc.spanLayers?.[j], null);
      } else {
        const i = this._selectedIndex();
        const layer = this.state.doc.slides[i]?.layers?.[j];
        if (layer) this._paintLayerChrome(i, layer.box, { v: [], h: [] });
      }
    }

    // A keyboard nudge rebuilds the strip under the user's fingers; put focus
    // back where it was so the next arrow press keeps working.
    if (this._refocus != null) {
      const i = this._refocus;
      this._refocus = null;
      this.$(`.carousel-studio__stage-slide[data-slice="${i}"]`)?.focus?.();
    }

    // The same for the rail: a keyboard reorder rebuilds the strip out from
    // under the handle the user is holding, so put focus on it where it landed.
    if (this._refocusRail != null) {
      const i = this._refocusRail;
      this._refocusRail = null;
      this.$(`.carousel-studio__rail-handle[data-slide="${i}"]`)?.focus?.();
    }
  }

  /**
   * Split-mode preview: one crop band across the stage, one column per frame,
   * and the rail that says where in its slack the band sits.
   *
   * `anchorOverride` is the live drag's provisional value — the same argument
   * `_paintDeckSlide` takes a provisional slide for, and for the same reason:
   * a gesture and a committed document are painted by identical code.
   *
   * @param {string} source
   * @param {number} [anchorOverride]
   */
  _paintSplit(source, anchorOverride) {
    const { srcW, srcH } = this.state;
    const { aspect, slides } = this.state.doc;
    const anchorY = anchorOverride ?? this.state.doc.anchorY;
    paintSplit(
      {
        stage: this.$(".carousel-studio__stage"),
        frames: this.$$(".carousel-studio__frame"),
      },
      {
        source,
        srcW,
        srcH,
        aspect,
        anchorY,
        n: slides.length,
        strategy: /** @type {'cover'|'exact'|'pad'} */ (this.state.doc.strategy),
      },
    );
    paintAnchorRail(this.$(".carousel-studio__anchor-rail"), anchorY);
  }

  /**
   * What the anchor gesture is allowed to know about the document: where the
   * band sits and how much room the current strategy leaves it. Null whenever
   * there is nothing to drag — deck mode, no source pixels yet, or a crop that
   * fills the height exactly — which is the `report.trimmedH > 1` condition
   * `panels.js` draws the rail and the slider under.
   */
  _anchorMetrics() {
    const doc = this.state.doc;
    const { srcW, srcH } = this.state;
    if (doc.mode === "deck" || !srcW || !srcH) return null;
    const report = fitReport(
      srcW,
      srcH,
      doc.slides.length,
      doc.aspect,
      /** @type {'cover'|'exact'|'pad'} */ (doc.strategy),
    );
    if (!(report.trimmedH > 1)) return null;
    const [, dstH] = canvasSize(doc.aspect);
    return { anchorY: doc.anchorY, trimmedH: report.trimmedH, scale: report.scale, dstH };
  }

  /**
   * Paint a provisional anchor: the band, the rail, and the slider — which is
   * the same control by another face, so it tracks the drag rather than going
   * stale until the commit rebuilds it.
   *
   * @param {number} anchorY
   */
  _paintAnchor(anchorY) {
    const source = this._source();
    if (source) this._paintSplit(source, anchorY);
    const slider = /** @type {HTMLInputElement|null} */ (this.$("#carousel-anchor"));
    if (slider) slider.value = String(anchorY);
    const out = this.$("#carousel-anchor-out");
    if (out) out.textContent = `${Math.round(anchorY * 100)}%`;
  }

  /** Deck-mode preview: every slide's own crop, on its own image element. */
  _paintDeck() {
    this.state.doc.slides.forEach((slide, i) => this._paintDeckSlide(i, slide));
  }

  /** Paint the deck's spanning layers over slide `i`, from `spanLayers` unless a
   *  provisional list is given (a live span-form edit). Positioned per slide
   *  through `spanLayerRect`, so the seam falls where the render puts it. */
  _paintSpanLayersForSlide(i, spanLayers) {
    paintSpanLayers(
      { hosts: this.$$(`[data-slice="${i}"]`) },
      {
        spanLayers: spanLayers || this.state.doc.spanLayers,
        aspect: this.state.doc.aspect,
        index: i,
        count: this.state.doc.slides.length,
        selected: this.state.layerScope === "span" ? this.state.selectedLayer : null,
      },
    );
  }

  /** Repaint every slice's span layers — for a live span-form edit, where one
   *  layer changing shows on every slide it crosses. */
  _paintSpanLayers(spanLayers) {
    for (let i = 0; i < this.state.doc.slides.length; i++) {
      this._paintSpanLayersForSlide(i, spanLayers);
    }
  }

  /**
   * Paint one deck slide — the stage slice and the filmstrip frame both carry
   * `data-slice`, so one query finds every element showing it. Called with a
   * provisional slide mid-gesture and with the document's own slide otherwise,
   * which is what keeps a drag and a commit painting identically.
   *
   * @param {number} i
   * @param {import('./document.js').CarouselSlide} slide
   */
  _paintDeckSlide(i, slide) {
    const { srcW, srcH } = this._dimsFor(slide);
    paintDeckSlide(
      {
        imgs: this.$$(`[data-slice="${i}"] .carousel-studio__frame-img`),
        bgs: this.$$(`[data-slice="${i}"] .carousel-studio__frame-bg`),
      },
      { slide, srcW, srcH, aspect: this.state.doc.aspect, hasPad: this._hasPad(slide) },
    );
    this._paintDeckSlideLayers(i, slide.layers);
    this._paintSpanLayersForSlide(i);
  }

  /** Paint one slide's layers onto both elements that show it. Split out so a
   *  live property-form edit can repaint with a provisional list without
   *  touching the crop. */
  _paintDeckSlideLayers(i, layers) {
    paintDeckLayers(
      { hosts: this.$$(`[data-slice="${i}"]`) },
      {
        layers,
        aspect: this.state.doc.aspect,
        index: i,
        count: this.state.doc.slides.length,
      },
    );
  }

  /** Repaint one layer at a provisional box mid-drag — the layer twin of the
   *  provisional slide `_paintDeckSlide` takes. Also moves the selection chrome
   *  and draws whatever snap guides engaged. No state change, so a drag costs
   *  no rebuild. `i` is `SPAN_SLIDE` for a deck-wide layer, which repaints on
   *  every column instead of one, since a drag of it moves it on all of them. */
  _paintProvisionalLayer(i, j, box, guides) {
    if (i === SPAN_SLIDE) {
      const list = (this.state.doc.spanLayers || []).map((l, k) =>
        k === j ? { ...l, box } : l,
      );
      this._paintSpanLayers(list);
      this._paintSpanChrome(list[j], guides);
      return;
    }
    const layers = (this.state.doc.slides[i]?.layers || []).map((l, k) =>
      k === j ? { ...l, box } : l,
    );
    this._paintDeckSlideLayers(i, layers);
    this._paintLayerChrome(i, box, guides);
  }

  /** Position the selection chrome for a span layer on every stage column,
   *  sliced per column by `spanLayerRect` the same way its preview element is —
   *  so the outline and the handles run across a seam, and a column the layer
   *  does not reach has its chrome hidden rather than removed. `guides` arrive
   *  in deck fractions and are re-based per column; empty except mid-drag. */
  _paintSpanChrome(layer, guides) {
    const { aspect } = this.state.doc;
    const count = this.state.doc.slides.length;
    for (let i = 0; i < count; i++) {
      paintSpanChrome(
        { hosts: this.$$(`[data-slice="${i}"]`) },
        {
          layer: layer || null,
          aspect,
          index: i,
          count,
          guides: guides || { v: [], h: [] },
        },
      );
    }
  }

  /** Position the selection outline, handles and snap guides for the selected
   *  layer over both elements that show slide `i`. `guides` is empty except
   *  mid-drag. */
  _paintLayerChrome(i, box, guides) {
    paintLayerChrome(
      { hosts: this.$$(`[data-slice="${i}"]`) },
      { box, aspect: this.state.doc.aspect, guides: guides || { v: [], h: [] } },
    );
  }

  // ── Control wiring ────────────────────────────────────────────────────────

  _wireControls() {
    const nInput = /** @type {HTMLInputElement|null} */ (this.$("#carousel-n"));
    const nOut = this.$("#carousel-n-out");
    // Live readout while dragging; commit to the document (and re-render the
    // preview) only on release, so the slider doesn't fight a rebuild mid-drag.
    this.on(nInput, "input", () => {
      if (nOut) nOut.textContent = String(nInput.value);
    });
    this.on(nInput, "change", () => {
      // A manual count is a free `cover` count — the pixel-exact strategies own
      // their slide count, so leaving `strategy` on `exact`/`pad` here would
      // show a stale readout. The chips and the radio set both together.
      this._setSplit({ n: clampSlides(Number(nInput.value)), strategy: "cover" });
    });

    this.on(this.$("#carousel-aspect"), "change", (e) => {
      const aspect = /** @type {HTMLSelectElement} */ (e.target).value;
      // Deck slides carry their own crops, so an aspect change reframes them
      // where a split deck has to be re-sliced from scratch.
      this._setDoc(
        this.state.doc.mode === "deck"
          ? normalizeDocument({ ...this.state.doc, aspect })
          : this._splitDoc({ aspect }),
      );
    });
    this.on(this.$("#carousel-guides"), "change", (e) => {
      this.setState({ showGuides: /** @type {HTMLInputElement} */ (e.target).checked });
    });

    const anchor = /** @type {HTMLInputElement|null} */ (this.$("#carousel-anchor"));
    if (anchor) {
      const anchorOut = this.$("#carousel-anchor-out");
      this.on(anchor, "input", () => {
        if (anchorOut) {
          anchorOut.textContent = `${Math.round(Number(anchor.value) * 100)}%`;
        }
      });
      this.on(anchor, "change", () => {
        this._setSplit({ anchorY: Number(anchor.value) });
      });
    }

    // The keyboard half of the rail reorder: the handle is a button, so the
    // arrows are free, and left/right is the axis the rail runs on (see
    // `_setupSlideReorder`). Without this the reorder would be pointer-only,
    // which is the failure the arrange mode in `PostEditPage` avoids the same
    // way. Delegated on the strip, so it survives the rebuild a move causes.
    this.on(this.$(".carousel-studio__filmstrip"), "keydown", (e) => {
      const ev = /** @type {KeyboardEvent} */ (e);
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      const handle = /** @type {HTMLElement|null} */ (
        /** @type {HTMLElement} */ (ev.target).closest?.(".carousel-studio__rail-handle")
      );
      if (!handle) return;
      ev.preventDefault();
      const from = Number(handle.dataset.slide);
      this._moveSlide(from, from + (ev.key === "ArrowLeft" ? -1 : 1), { refocus: true });
    });

    this._wireBgFields();
    this._wireLayerFields();
  }

  /**
   * The selected layer's property-form fields. Same split as every other live
   * control: `input` repaints that one layer's DOM elements from a provisional
   * patch, `change` commits it through `updateLayer`. `text`'s `source` is set
   * by the media picker, not a field here, so it is not in this list.
   */
  _wireLayerFields() {
    const ids = [
      "#carousel-layer-text",
      "#carousel-layer-format",
      "#carousel-layer-color",
      "#carousel-layer-fill",
      "#carousel-layer-align",
      "#carousel-layer-valign",
      "#carousel-layer-weight",
      "#carousel-layer-shadow",
      "#carousel-layer-fit",
      "#carousel-layer-direction",
      "#carousel-layer-radius",
      "#carousel-layer-opacity",
    ];
    const fields = ids.map((sel) => this.$(sel)).filter(Boolean);

    for (const el of fields) {
      this.on(el, "input", () => {
        const { i, scope, j, layer } = this._selectedLayerRef();
        if (!layer) return;
        this._syncLayerOutputs();
        const source = scope === "span" ? this.state.doc.spanLayers : this.state.doc.slides[i].layers;
        const list = source.map((l, k) =>
          k === j ? { ...l, ...this._layerFromFields(layer) } : l,
        );
        if (scope === "span") this._paintSpanLayers(list);
        else this._paintDeckSlideLayers(i, list);
      });
      this.on(el, "change", () => {
        const { layer } = this._selectedLayerRef();
        if (layer) this._setLayer(this._layerFromFields(layer));
      });
    }
  }

  /** Mirror the layer form's range values into their `<output>`s while dragging,
   *  before the change commits and rebuilds. */
  _syncLayerOutputs() {
    const put = (sel, text) => {
      const out = this.$(sel);
      if (out) out.textContent = text;
    };
    const opacity = /** @type {HTMLInputElement|null} */ (this.$("#carousel-layer-opacity"));
    if (opacity) put("#carousel-layer-opacity-out", `${Math.round(Number(opacity.value) * 100)}%`);
    const weight = /** @type {HTMLInputElement|null} */ (this.$("#carousel-layer-weight"));
    if (weight) put("#carousel-layer-weight-out", weight.value);
    const radius = /** @type {HTMLInputElement|null} */ (this.$("#carousel-layer-radius"));
    if (radius) put("#carousel-layer-radius-out", `${Math.round(Number(radius.value) * 100)}%`);
  }

  /**
   * The patch the layer form's fields currently describe, keyed by the layer's
   * own `type`. Reads the DOM rather than an event, so one handler serves every
   * field. A value the schema rejects (an empty number field) is left to
   * `updateLayer` to drop back to the layer's own — its `base` argument.
   *
   * @param {import('./document.js').CarouselLayer} layer
   * @returns {object}
   */
  _layerFromFields(layer) {
    const val = (sel) => {
      const el = /** @type {HTMLInputElement|null} */ (this.$(sel));
      return el ? el.value : undefined;
    };
    const checked = (sel) => {
      const el = /** @type {HTMLInputElement|null} */ (this.$(sel));
      return el ? el.checked : undefined;
    };
    const t = layer.type;

    if (t === "text" || t === "counter") {
      const style = {
        color: val("#carousel-layer-color"),
        align: val("#carousel-layer-align"),
        valign: val("#carousel-layer-valign"),
        weight: Number(val("#carousel-layer-weight")),
        shadow: checked("#carousel-layer-shadow"),
      };
      return t === "text"
        ? { ...style, text: val("#carousel-layer-text") ?? layer.text }
        : { ...style, format: val("#carousel-layer-format") ?? layer.format };
    }
    if (t === "image") {
      return { fit: val("#carousel-layer-fit"), opacity: Number(val("#carousel-layer-opacity")) };
    }
    if (t === "rect") {
      return {
        fill: val("#carousel-layer-fill"),
        radius: Number(val("#carousel-layer-radius")),
        opacity: Number(val("#carousel-layer-opacity")),
      };
    }
    if (t === "arrow") {
      return {
        direction: val("#carousel-layer-direction"),
        color: val("#carousel-layer-color"),
        opacity: Number(val("#carousel-layer-opacity")),
      };
    }
    return {};
  }

  /**
   * The background fill's own fields — the colour ends and the gradient angle.
   * The type chips are an action; these edit the type that is already chosen.
   *
   * Same split as every other live control here: `input` repaints the fill
   * layer straight into the DOM, `change` commits it to the document. Dragging
   * a colour picker across a hue ramp therefore costs two style writes per step
   * rather than a document mutation and a rebuild.
   */
  _wireBgFields() {
    const angle = /** @type {HTMLInputElement|null} */ (this.$("#carousel-bg-angle"));
    const angleOut = this.$("#carousel-bg-angle-out");
    const fields = ["#carousel-bg-color", "#carousel-bg-from", "#carousel-bg-to"]
      .map((sel) => this.$(sel))
      .concat(angle)
      .filter(Boolean);

    for (const el of fields) {
      this.on(el, "input", () => {
        const i = this._selectedIndex();
        const slide = this.state.doc.slides[i];
        if (!slide) return;
        if (angleOut && angle) angleOut.textContent = `${angle.value}°`;
        this._paintDeckSlide(i, { ...slide, bg: this._bgFromFields(slide) });
      });
      this.on(el, "change", () => {
        const i = this._selectedIndex();
        const slide = this.state.doc.slides[i];
        if (slide) this._setSlideFraming(i, { bg: this._bgFromFields(slide) });
      });
    }
  }

  /**
   * The background the panel's fields currently describe, over `slide`'s own
   * type. Reads the DOM rather than an event, so one handler serves every
   * field: whichever moved, the result is the whole fill.
   *
   * A gradient is rebuilt as its two ends — the control edits a `from` and a
   * `to`, and a hand-authored document with more stops renders them all but
   * loses the middle ones the moment this panel writes.
   *
   * @param {import('./document.js').CarouselSlide} slide
   * @returns {object|null}
   */
  _bgFromFields(slide) {
    const value = (sel, fallback) => {
      const el = /** @type {HTMLInputElement|null} */ (this.$(sel));
      return el ? el.value : fallback;
    };
    const bg = slide.bg;
    if (bg?.type === "solid") {
      return { type: "solid", color: value("#carousel-bg-color", bg.color) };
    }
    if (bg?.type === "gradient") {
      const last = bg.stops[bg.stops.length - 1];
      return {
        type: "gradient",
        angle: Number(value("#carousel-bg-angle", String(bg.angle))),
        stops: [
          { at: 0, color: value("#carousel-bg-from", bg.stops[0].color) },
          { at: 1, color: value("#carousel-bg-to", last.color) },
        ],
      };
    }
    return bg;
  }
}
