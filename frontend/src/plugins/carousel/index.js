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
 * — and this file is the chrome that drives them. Layers and templates land in
 * later stages (see docs/features/carousel-studio.md).
 *
 * Live preview is CSS, never canvas: a pan or a zoom writes
 * `background-size`/`background-position` from `deckSlideFitCSS` straight onto
 * the frame's image element and commits to the document only when the gesture
 * ends, so dragging costs no decode and no re-render.
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
import { setToast } from "../../store.js";
import { showConfirm } from "../../utils/dialogs.js";
import { html, navigate, raw } from "../../utils/helpers.js";
import { REFRESH_SVG } from "../../utils/icons.js";
import {
  backgroundFit,
  canvasSize,
  clampPan,
  deckSlideFitCSS,
  fitReport,
  safeAreaRect,
  slideCountOptions,
} from "./geometry.js";
import {
  applyCarouselBlock,
  emptyDocument,
  normalizeDocument,
  parseDocument,
  serializeDocument,
  specHash,
  splitDocument,
  toDeckDocument,
  updateSlideFraming,
} from "./document.js";
import { browserDeps, renderAndUpload } from "./render.js";

/** Slide-count bounds. Instagram accepts up to 20 images per carousel
 *  (`api/internal/services/post_publish.go` truncates there;
 *  `docs/features/carousel-studio.md` says 2–20) — the studio spans the range. */
const MIN_SLIDES = 2;
const MAX_SLIDES = 20;
const DEFAULT_SLIDES = 3;

/** Clamp a slide count into the studio's bounds. */
const clampSlides = (v) => Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, Math.floor(v)));

/** Behind the source image on the stage and every filmstrip frame — visible
 *  only where the image doesn't reach (the `pad` strategy's trailing gap on
 *  its last slide, a contained deck slide's letterbox), so padding reads as a
 *  deliberate block rather than a stretched or missing image. */
const PAD_HATCH =
  "repeating-linear-gradient(45deg, var(--surface-hover) 0 6px, transparent 6px 12px)";

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

const ASPECT_OPTIONS = [
  ["4:5", "Portrait 4:5"],
  ["1:1", "Square 1:1"],
  ["1.91:1", "Landscape 1.91:1"],
];

/** Wheel-notch → zoom factor. One notch (100px) is ~16%, and the exponential
 *  keeps zooming in and back out along the same path. */
const WHEEL_ZOOM = 0.0015;
/** One arrow press pans this fraction of the visible crop (5× with shift). */
const KEY_PAN = 0.02;
/** One `+`/`-` press zooms by this factor. */
const KEY_ZOOM = 1.1;
/** A wheel gesture has no release event — commit this long after the last tick.
 *  Long enough that a scroll burst is one document mutation, short enough that
 *  the dirty badge feels immediate. */
const WHEEL_COMMIT_MS = 140;
/** Pointer travel below this is a click, not a drag. */
const DRAG_SLOP_PX = 3;

/** The post id from `?post=`, or null when absent/malformed. */
function readPostId(query) {
  const raw = /** @type {{ post?: string }} */ (query || {}).post;
  return raw != null && /^[0-9]+$/.test(String(raw)) ? Number(raw) : null;
}

/** A picked media item is usable as a split source only if it is an image. */
function isImagePath(path) {
  return typeof path === "string" && !/\.(mp4|mov|webm|m4v|avi)$/i.test(path);
}

/** The midpoint and spread of the live pointers — one finger gives `dist: 0`,
 *  which is what makes the same handler serve a drag and a pinch. */
function pointerCentroid(pointers) {
  const pts = [...pointers.values()];
  if (!pts.length) return { cx: 0, cy: 0, dist: 0 };
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const dist =
    pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  return { cx, cy, dist };
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
      // Source pixel size, re-probed on load and on every source change: derived
      // data, so it is never a document field.
      srcW: null,
      srcH: null,
      selected: 0,
      showGuides: true,
      busy: false,
      renderProgress: null,
      hasCarousel: false,
    };
    this._picker = null;
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
    // The in-flight gesture: { i, frame, pointers, crop, startCrop, start, moved }.
    this._drag = null;
    // A crop written to the DOM but not yet committed to the document (a wheel
    // gesture, which has no release event to commit on).
    this._pending = null;
    this._pendingTimer = null;
    // Slide index to restore focus to after a keyboard nudge rebuilds the strip.
    this._refocus = null;
  }

  actions = {
    "back-to-post"() {
      navigate(`/light/posts/${this.state.postId}/edit`);
    },
    "pick-source"() {
      this._openPicker();
    },
    render() {
      this._render();
    },
    "remove-carousel"() {
      this._confirmRemove();
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
    "reset-slide"(_e, el) {
      this._setSlideFraming(Number(el.dataset.slide), {
        crop: { x: 0, y: 0, w: 1, h: 1 },
        fit: "cover",
      });
    },
  };

  mount() {
    super.mount();
    this._load();
  }

  beforeUnmount() {
    this._picker?.destroy();
    this._picker = null;
    clearTimeout(this._pendingTimer);
    this._pendingTimer = null;
  }

  // ── Document accessors ────────────────────────────────────────────────────

  /** The one source every slide is drawn from. Per-slide sources are a later
   *  stage; until then slide 0 answers for the deck. */
  _source() {
    return this.state.doc.slides[0]?.source || "";
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
      const doc = carousel ? parseDocument(carousel.doc) : emptyDocument();
      this._priorRendered = doc.slides.map((s) => s.rendered).filter((r) => r && r.path);
      const fullyRendered = doc.slides.length > 0 && doc.slides.every((s) => s.rendered);
      this._renderedDoc = fullyRendered ? serializeDocument(doc) : null;
      this.setState({
        loading: false,
        post,
        doc,
        selected: 0,
        hasCarousel: Boolean(carousel),
      });
      // The document does not store source pixels — re-probe them so the fit
      // panel has its numbers. The image is cache-warm from the CSS background.
      const source = doc.slides[0]?.source;
      if (source) this._probeSource(source);
    } catch (err) {
      if (this._unmounted) return;
      this.setState({ loading: false, error: err?.message || "Could not load the post." });
    }
  }

  _openPicker() {
    if (!this._picker) {
      this._picker = new MediaPickerDialog({
        onConfirm: (items) => {
          const img = (items || []).find((m) => isImagePath(m?.path));
          if (!img) return;
          // The media mapper emits width/height (api/internal/api/mappers.go);
          // they are null for a pre-dimensions upload — probe the bitmap then.
          const w = Number.isFinite(img.width) ? img.width : null;
          const h = Number.isFinite(img.height) ? img.height : null;
          const doc = this.state.doc;
          // In deck mode the slides carry framing the user set by hand: swap the
          // source under them (crops are normalized, so they stay valid) rather
          // than throwing that work away. Split mode has nothing per-slide to
          // lose, so a new image starts a fresh projection.
          const next =
            doc.mode === "deck" && doc.slides.length
              ? normalizeDocument({
                  ...doc,
                  slides: doc.slides.map((s) => ({ ...s, source: img.path })),
                })
              : this._splitDoc({ source: img.path, strategy: "cover", anchorY: 0.5 });
          this.setState({ doc: next, srcW: w, srcH: h });
          if (!w || !h) this._probeSource(img.path);
        },
      });
      this._picker.mount();
    }
    this._picker.open();
  }

  /** Fill `srcW`/`srcH` from a natural-size probe of the source image. On
   *  failure the fit panel simply stays hidden and the bare slider is used. */
  async _probeSource(path) {
    try {
      const deps = this.props.renderDeps || browserDeps();
      const { w, h } = await deps.probeSize(path);
      if (this._unmounted || this._source() !== path) return;
      this.setState({ srcW: w || null, srcH: h || null });
    } catch {
      /* no dimensions — _renderFitPanel() falls back to the plain controls */
    }
  }

  // ── Document mutation ─────────────────────────────────────────────────────

  /**
   * Rebuild the split projection with `patch` applied over the current
   * doc-level controls. Each slide's `rendered` block is carried over by index
   * so an unchanged slide still skips its re-encode — its `specHash` simply
   * misses wherever the projection actually moved (see `_render`).
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
    });
    next.slides.forEach((slide, i) => {
      slide.rendered = doc.slides[i]?.rendered ?? null;
    });
    return next;
  }

  /** Apply a doc-level split control. */
  _setSplit(patch) {
    const doc = this._splitDoc(patch);
    this.setState({ doc, selected: Math.min(this.state.selected, doc.slides.length - 1) });
  }

  /**
   * Switch framing mode. Split → deck is a freeze: `toDeckDocument` writes each
   * slide the crop `sliceRects` was already deriving for it, so nothing on
   * screen moves. Deck → split throws that per-slide work away, so it asks
   * first rather than losing it to a mis-click.
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
      this.setState({ doc: next, selected: 0 });
      // The freeze is invisible except for one case: `pad`'s short tail column
      // sat flush left with its gap on the right, and a deck slide can only
      // centre a contained crop. Say so, rather than let the user hunt for what
      // moved (see toDeckDocument in document.js).
      const recentred = next.slides.some((s) => s.fit === "contain");
      setToast({
        message: recentred
          ? "Deck mode — drag a slide to pan, wheel to zoom. The padded slide is now centred, not flush left."
          : "Deck mode — drag a slide to pan, wheel to zoom.",
        type: "success",
      });
      return;
    }

    this._showConfirm(
      "Back to split mode",
      "Split mode re-derives every slide from one strip. The per-slide pan, zoom and fit set here are discarded — this cannot be undone.",
      "Discard framing",
      "danger",
      () => this.setState({ doc: this._splitDoc(), selected: 0 }),
    );
  }

  /** The single writer for per-slide framing — every gesture, key and button
   *  lands here, and clamping is `updateSlideFraming`'s job, not the caller's. */
  _setSlideFraming(i, update) {
    const { srcW, srcH } = this.state;
    this.setState({
      selected: i,
      doc: updateSlideFraming(this.state.doc, i, update, {
        srcW: srcW || 0,
        srcH: srcH || 0,
      }),
    });
  }

  /**
   * Apply a fit-panel radio choice: `cover` keeps the current count; `fill`,
   * `exact` and `pad` each snap the count to what the strategy makes from this
   * source (`ceil`/`floor` of `srcW / slideW`), clamped to the studio bounds.
   *
   * @param {string} mode  one of `FIT_MODES`
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

  /** Which `FIT_MODES` radio the current document reads as. `cover` at exactly
   *  the width-filling count is shown as `fill`; the two are otherwise identical. */
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

  async _render() {
    const { postId, post, srcW, srcH } = this.state;
    const doc = this.state.doc;
    if (!this._source() || !doc.slides.length || this.state.busy) return;
    const total = doc.slides.length;

    this.setState({ busy: true, error: null, renderProgress: { done: 0, total } });
    try {
      const deps = this.props.renderDeps || browserDeps();
      const hashOf = (slide) =>
        specHash(slide, doc.aspect, { strategy: doc.strategy, anchorY: doc.anchorY });

      // A slide whose specHash still matches the one stored with its render has
      // identical inputs (source/crop/fit/bg, plus the doc-level framing folded
      // in) — reuse its media row rather than re-encode and re-upload it. In
      // deck mode that is what makes nudging one slide re-upload exactly one.
      const keep = doc.slides.map((slide) => {
        const prior = slide.rendered;
        if (!prior || !Number.isFinite(prior.media_id)) return null;
        return hashOf(slide) === prior.specHash
          ? { id: prior.media_id, path: prior.path }
          : null;
      });

      const media = await renderAndUpload(
        {
          doc,
          postId,
          srcW: srcW || undefined,
          srcH: srcH || undefined,
        },
        deps,
        (p) => {
          if (!this._unmounted) this.setState({ renderProgress: p });
        },
        keep,
      );

      // Byte-identical slides dedup to one media row server-side (SHA256), so
      // two slides would share a path — which the blog renders twice but
      // Instagram (ExtractMediaPaths dedups) renders once. Rather than let the
      // two disagree, forbid it here. See docs/features/carousel-studio.md.
      if (new Set(media.map((m) => m.id)).size !== media.length) {
        throw new Error(
          "Two slides came out byte-identical — change the slide count, the aspect or one slide's framing so every slide is distinct.",
        );
      }

      const next = normalizeDocument({
        ...doc,
        slides: doc.slides.map((slide, i) => ({
          ...slide,
          rendered: {
            path: media[i].path,
            media_id: media[i].id,
            specHash: hashOf(slide),
          },
        })),
      });
      await saveCarousel(postId, next);
      const content = applyCarouselBlock(post.content, next);
      const updated = await updatePost(postId, this._postPayload(post, content));
      const finalContent = updated?.content ?? content;

      // The previous generation's slides are now unreferenced: orphan detection
      // keys on `post_id IS NULL` and these carry a post_id, so they would sit
      // on disk forever. Delete each superseded row explicitly — but never one
      // whose path still appears in the post (a slide reused inline, say), and
      // never one this render just reused via `keep`.
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
      this._priorRendered = next.slides.map((s) => s.rendered).filter((r) => r && r.path);
      this._renderedDoc = serializeDocument(next);

      if (this._unmounted) return;
      this.setState({
        busy: false,
        renderProgress: null,
        hasCarousel: true,
        post: { ...post, content: finalContent },
        doc: next,
      });
      setToast({ message: `Carousel rendered — ${media.length} slides.`, type: "success" });
    } catch (err) {
      if (this._unmounted) return;
      this.setState({ busy: false, renderProgress: null, error: err?.message || "Render failed." });
      setToast({ message: `Carousel render failed: ${err?.message || err}`, type: "error" });
    }
  }

  /** Imperative confirm/prompt plumbing, broken out so a test can override it
   *  without touching the DOM (see PostEditPage's `_showConfirm` for the same
   *  pattern). */
  _showConfirm(title, message, confirmText, variant, onConfirm) {
    showConfirm({ title, message, confirmText, variant, onConfirm });
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
      this.setState({
        busy: false,
        post: { ...post, content: finalContent },
        doc: emptyDocument(),
        srcW: null,
        srcH: null,
        selected: 0,
        hasCarousel: false,
      });
      setToast({ message: "Carousel removed.", type: "success" });
    } catch (err) {
      if (this._unmounted) return;
      this.setState({ busy: false, error: err?.message || "Could not remove carousel." });
      setToast({ message: `Remove failed: ${err?.message || err}`, type: "error" });
    }
  }

  // ── Markup ────────────────────────────────────────────────────────────────

  render() {
    const { postId } = this.state;
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

    return adminLayoutTemplate({
      title: "Carousel Studio",
      actions: this._renderActions(),
      content: this._renderStudio(),
    });
  }

  _renderActions() {
    const { busy, renderProgress, hasCarousel } = this.state;
    const dirty = this._isDirty();
    const source = this._source();
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
        ${!source || busy ? "disabled" : ""}
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

  _renderStudio() {
    const { loading, error, postId } = this.state;
    const lead = html`
      <p class="carousel-studio__lead">Building slides for this post.</p>`;

    if (loading) {
      return html`
        <section class="carousel-studio" data-post-id="${String(postId)}">
          ${lead}
          <div class="loading-spinner" aria-label="Loading…"></div>
        </section>`;
    }

    return html`
      <section class="carousel-studio" data-post-id="${String(postId)}">
        ${lead}
        ${error ? html`<p class="error-state" role="alert">${error}</p>` : ""}
        ${this._source() ? this._renderBuilder() : this._renderPickPrompt()}
      </section>`;
  }

  _renderPickPrompt() {
    return html`
      <div class="carousel-studio__pick">
        <p>Pick one image to slice into slides.</p>
        <button class="btn btn-primary" data-action="pick-source">Choose image</button>
      </div>`;
  }

  /** The image layer of one deck frame. Its own element, not the frame's
   *  background, because a contained slide's box is smaller than the frame —
   *  only an element cut down to the content rect keeps the source from
   *  bleeding into the letterbox the canvas fills with `bg`. */
  _deckImage() {
    return html`<span class="carousel-studio__frame-img"></span>`;
  }

  _renderBuilder() {
    const { showGuides, selected } = this.state;
    const doc = this.state.doc;
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
              ${this._deckImage()}
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
              ${this._deckImage()}
            </div>`
        : html`
            <div
              class="carousel-studio__frame"
              data-slice="${String(i)}"
              style="aspect-ratio:${String(w)}/${String(h)}"
            ></div>`,
    );

    const paths = this._renderedPaths();
    const renderedStrip = paths.length
      ? html`
          <div class="carousel-studio__rendered">
            <h2 class="carousel-studio__subhead">Rendered slides</h2>
            <div class="carousel-studio__slides">
              ${paths.map(
                (p) => html`<img class="carousel-studio__slide" src="${p}" alt="" loading="lazy" />`,
              )}
            </div>
          </div>`
      : "";

    return html`
      <div class="carousel-studio__builder">
        ${this._renderModeToggle()}

        <div
          class="carousel-studio__stage ${deck ? "carousel-studio__stage--deck" : ""}"
          style="aspect-ratio:${String(n * w)}/${String(h)}"
        >
          ${stageSlides}${dividers}${guides}
        </div>

        <div class="carousel-studio__filmstrip" aria-label="Slide preview">${strip}</div>

        ${deck ? this._renderDeckPanel() : this._renderFitPanel()}

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
   *  there would be nothing to derive the per-slide crops from. */
  _renderModeToggle() {
    const { srcW, srcH, busy } = this.state;
    const mode = this.state.doc.mode;
    const canDeck = Boolean(srcW && srcH);
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
   */
  _renderDeckPanel() {
    const doc = this.state.doc;
    const i = Math.min(this.state.selected, doc.slides.length - 1);
    const slide = doc.slides[i];
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
          Slide ${String(i + 1)} of ${String(doc.slides.length)} · drag to pan ·
          wheel or pinch to zoom · arrow keys nudge
        </p>

        <div class="carousel-studio__fit-chips" role="group" aria-label="Slide fit">
          ${SLIDE_FITS.map(
            ([val, text]) => html`
              <button
                type="button"
                class="carousel-studio__chip ${slide.fit === val ? "is-active" : ""}"
                data-action="slide-fit"
                data-slide="${String(i)}"
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
            data-slide="${String(i)}"
          >
            Reset framing
          </button>
        </div>

        <p class="carousel-studio__fit-readout" aria-live="polite">${readout}</p>
      </div>`;
  }

  /**
   * The fit panel: source dimensions, one-click count/strategy chips, the
   * strategy radio, a live `fitReport` readout for the current selection, an
   * upscale warning, and a vertical-anchor slider that appears only when the
   * crop leaves vertical slack. Hidden entirely until the source pixel size is
   * known (a probe may still be in flight, or have failed).
   */
  _renderFitPanel() {
    const { srcW, srcH } = this.state;
    const doc = this.state.doc;
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
    const fitMode = this._currentFitMode();

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

  // ── Preview painting ──────────────────────────────────────────────────────

  afterRender() {
    setupAdminLayout(this, { currentPath: "/light/carousel" });

    const source = this._source();
    if (source) {
      if (this.state.doc.mode === "deck") this._paintDeck();
      else this._paintSplit(source);
    }

    this._wireControls();
    if (this.state.doc.mode === "deck") this._wireGestures();

    // A keyboard nudge rebuilds the strip under the user's fingers; put focus
    // back where it was so the next arrow press keeps working.
    if (this._refocus != null) {
      const i = this._refocus;
      this._refocus = null;
      this.$(`.carousel-studio__frame--deck[data-slice="${i}"]`)?.focus?.();
    }
  }

  /**
   * Split-mode preview. The source image drives both the stage and every
   * filmstrip frame as a CSS background — set from JS so a media path never
   * lands in a style string the html`` tag can only HTML-escape, not
   * CSS-escape. Size and position reproduce the real per-slide crop
   * (`backgroundFit`, mirroring `sliceRects`) so the preview never lies about
   * what the render will produce; a hatch layer sits behind the image so
   * `pad`'s trailing gap reads as a deliberate block instead of stretched or
   * missing image.
   */
  _paintSplit(source) {
    const { srcW, srcH } = this.state;
    const { aspect, anchorY } = this.state.doc;
    const n = this.state.doc.slides.length;
    const strategy = /** @type {'cover'|'exact'|'pad'} */ (this.state.doc.strategy);

    const bg = `url("${encodeURI(source)}"), ${PAD_HATCH}`;
    const stage = this.$(".carousel-studio__stage");
    const frames = this.$$(".carousel-studio__frame");
    const applyBg = (el, size, position) => {
      el.style.backgroundImage = bg;
      el.style.backgroundRepeat = "no-repeat, no-repeat";
      el.style.backgroundSize = `${size[0]}% ${size[1]}%, 100% 100%`;
      el.style.backgroundPosition = `${position[0]}% ${position[1]}%, 0% 0%`;
    };

    if (srcW && srcH) {
      if (stage) {
        const fit = backgroundFit(srcW, srcH, aspect, n, strategy, anchorY, n, 0);
        applyBg(stage, fit.size, fit.position);
      }
      frames.forEach((el, i) => {
        const fit = backgroundFit(srcW, srcH, aspect, n, strategy, anchorY, 1, i);
        applyBg(el, fit.size, fit.position);
      });
    } else {
      // Dimensions not known yet (probe in flight or failed) — no aspect
      // ratio to compute a real crop from, so fall back to CSS `cover` on
      // the stage (its declared default) and a plain stretch per frame, as
      // before. Self-corrects once the probe resolves and re-renders.
      if (stage) {
        stage.style.backgroundImage = `url("${encodeURI(source)}")`;
        stage.style.backgroundRepeat = "no-repeat";
      }
      frames.forEach((el, i) => {
        const posX = n > 1 ? (i / (n - 1)) * 100 : 0;
        applyBg(el, [n * 100, 100], [posX, 50]);
      });
    }
  }

  /** Deck-mode preview: every slide's own crop, on its own image element. */
  _paintDeck() {
    this.state.doc.slides.forEach((slide, i) => this._paintDeckSlide(i, slide));
  }

  /**
   * Write one slide's framing onto both elements that show it (the stage slice
   * and the filmstrip frame). The only place deck framing reaches the DOM — a
   * gesture calls it with a provisional slide, so the drag and the committed
   * document are painted by identical code.
   *
   * @param {number} i
   * @param {import('./document.js').CarouselSlide} slide
   */
  _paintDeckSlide(i, slide) {
    const { srcW, srcH } = this.state;
    const fit = deckSlideFitCSS(srcW || 0, srcH || 0, this.state.doc.aspect, slide.crop, slide.fit);
    const url = slide.source ? `url("${encodeURI(slide.source)}")` : "none";
    this.$$(`[data-slice="${i}"] .carousel-studio__frame-img`).forEach((el) => {
      el.style.backgroundImage = url;
      el.style.backgroundRepeat = "no-repeat";
      el.style.backgroundSize = `${fit.size[0]}% ${fit.size[1]}%`;
      el.style.backgroundPosition = `${fit.position[0]}% ${fit.position[1]}%`;
      el.style.left = `${fit.box.x}%`;
      el.style.top = `${fit.box.y}%`;
      el.style.width = `${fit.box.w}%`;
      el.style.height = `${fit.box.h}%`;
    });
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
      this.setState(
        this.state.doc.mode === "deck"
          ? { doc: normalizeDocument({ ...this.state.doc, aspect }) }
          : { doc: this._splitDoc({ aspect }) },
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
  }

  // ── Deck gestures ─────────────────────────────────────────────────────────

  _wireGestures() {
    this.$$(".carousel-studio__frame--deck").forEach((frame) => {
      const i = Number(frame.dataset.slice);
      this.on(frame, "pointerdown", (e) => this._onPointerDown(e, frame, i));
      this.on(frame, "pointermove", (e) => this._onPointerMove(e, frame, i));
      this.on(frame, "pointerup", (e) => this._onPointerUp(e, frame, i));
      this.on(frame, "pointercancel", (e) => this._onPointerUp(e, frame, i));
      // Not passive: a zoom over the strip must not also scroll the page.
      this.on(frame, "wheel", (e) => this._onWheel(e, i), { passive: false });
      this.on(frame, "keydown", (e) => this._onFrameKey(e, i));
      this.on(frame, "focus", () => {
        if (!this._drag) this._select(i);
      });
    });
  }

  /** Select a slide, if that is a change — the deck panel follows the selection,
   *  so this re-renders and must never run mid-gesture. */
  _select(i) {
    if (this.state.selected !== i) this.setState({ selected: i });
  }

  /**
   * Normalized source units per CSS pixel of the slide's image element, read
   * from the same `deckSlideFitCSS` the preview draws with — which is what makes
   * a 100px drag move the image 100px, at any zoom and either `fit`.
   */
  _panScale(crop, fit, box) {
    const { srcW, srcH } = this.state;
    const css = deckSlideFitCSS(srcW || 0, srcH || 0, this.state.doc.aspect, crop, fit);
    const per = (sizePct, px) => (sizePct > 0 && px > 0 ? 100 / sizePct / px : 0);
    return { x: per(css.size[0], box.width), y: per(css.size[1], box.height) };
  }

  /** Scale a crop about its own centre. `ratio > 1` widens the crop (zooms out). */
  _zoomCrop(crop, ratio) {
    const w = crop.w * ratio;
    const h = crop.h * ratio;
    return { x: crop.x + (crop.w - w) / 2, y: crop.y + (crop.h - h) / 2, w, h };
  }

  /** Clamp through the same helper `updateSlideFraming` commits with, so the
   *  preview is pinned at the edges exactly where the document will be. */
  _clamp(crop) {
    const { srcW, srcH } = this.state;
    return clampPan(crop, srcW || 0, srcH || 0);
  }

  /** Whether two crops resolve to the same whole source pixels — the only
   *  difference the render can see, since `deckSlideRects` rounds there. */
  _sameCrop(a, b) {
    const w = this.state.srcW || 1;
    const h = this.state.srcH || 1;
    return (
      Math.round(a.x * w) === Math.round(b.x * w) &&
      Math.round(a.y * h) === Math.round(b.y * h) &&
      Math.round(a.w * w) === Math.round(b.w * w) &&
      Math.round(a.h * h) === Math.round(b.h * h)
    );
  }

  /**
   * The one commit point for a gesture's crop. A drag that ran into the edge of
   * the source lands back on the crop it started from — give or take a float
   * ulp from the clamp — and committing that would mark the studio dirty and
   * re-encode a slide whose pixels are identical. So: repaint from the document
   * and leave it alone.
   */
  _commitCrop(i, crop) {
    const slide = this.state.doc.slides[i];
    if (!slide) return;
    const next = this._clamp(crop);
    if (this._sameCrop(next, slide.crop)) {
      this._paintDeckSlide(i, slide);
      this._select(i);
      return;
    }
    this._setSlideFraming(i, { crop: next });
  }

  _onPointerDown(e, frame, i) {
    if (e.button != null && e.button > 0) return;
    const slide = this.state.doc.slides[i];
    if (!slide) return;
    if (!this._drag || this._drag.i !== i) {
      this._drag = { i, frame, pointers: new Map(), crop: { ...slide.crop }, moved: false };
    }
    frame.setPointerCapture?.(e.pointerId);
    this._drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Re-baseline on every pointer down: a second finger arriving starts a
    // pinch from where the drag left off rather than from where it began.
    this._drag.start = pointerCentroid(this._drag.pointers);
    this._drag.startCrop = { ...this._drag.crop };
    frame.classList.add("is-dragging");
    e.preventDefault?.();
  }

  _onPointerMove(e, frame, i) {
    const drag = this._drag;
    if (!drag || drag.i !== i || !drag.pointers.has(e.pointerId)) return;
    drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const now = pointerCentroid(drag.pointers);
    const img = frame.querySelector(".carousel-studio__frame-img");
    const box = img?.getBoundingClientRect?.() || { width: 0, height: 0 };
    // Two fingers spreading apart shrink the crop; one finger leaves it alone.
    const ratio =
      drag.start.dist > 0 && now.dist > 0 ? drag.start.dist / now.dist : 1;
    const zoomed = this._zoomCrop(drag.startCrop, ratio);
    const scale = this._panScale(drag.startCrop, this.state.doc.slides[i].fit, box);
    const dx = now.cx - drag.start.cx;
    const dy = now.cy - drag.start.cy;
    // The image follows the pointer, so the crop moves the other way.
    const crop = this._clamp({
      ...zoomed,
      x: zoomed.x - dx * scale.x,
      y: zoomed.y - dy * scale.y,
    });

    if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX || ratio !== 1) {
      drag.moved = true;
    }
    drag.crop = crop;
    // Straight to the DOM — no setState, so a drag costs no rebuild and no
    // decode, only two style writes per frame.
    this._paintDeckSlide(i, { ...this.state.doc.slides[i], crop });
    e.preventDefault?.();
  }

  _onPointerUp(e, frame, i) {
    const drag = this._drag;
    if (!drag || drag.i !== i) return;
    drag.pointers.delete(e.pointerId);
    frame.releasePointerCapture?.(e.pointerId);
    if (drag.pointers.size) {
      // A finger lifted out of a pinch — carry on with the rest.
      drag.start = pointerCentroid(drag.pointers);
      drag.startCrop = { ...drag.crop };
      return;
    }

    frame.classList.remove("is-dragging");
    this._drag = null;
    if (!drag.moved) {
      // A click, not a drag: select the slide and leave its framing alone.
      this._select(i);
      return;
    }
    this._commitCrop(i, drag.crop);
  }

  _onWheel(e, i) {
    const slide = this.state.doc.slides[i];
    if (!slide || !e.deltaY) return;
    e.preventDefault?.();
    // deltaMode: 0 pixels, 1 lines, 2 pages — normalize to pixels so a Firefox
    // notch and a Chrome notch zoom by the same amount.
    const px =
      e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const base = this._pending?.i === i ? this._pending.crop : slide.crop;
    const crop = this._clamp(this._zoomCrop(base, Math.exp(px * WHEEL_ZOOM)));

    this._pending = { i, crop };
    this._paintDeckSlide(i, { ...slide, crop });
    // A wheel gesture has no release event, so the commit is debounced: one
    // document mutation per burst instead of one per notch.
    clearTimeout(this._pendingTimer);
    this._pendingTimer = setTimeout(() => this._commitPending(), WHEEL_COMMIT_MS);
  }

  _commitPending() {
    const pending = this._pending;
    this._pending = null;
    this._pendingTimer = null;
    if (!pending || this._unmounted) return;
    this._commitCrop(pending.i, pending.crop);
  }

  _onFrameKey(e, i) {
    const slide = this.state.doc.slides[i];
    if (!slide) return;
    const { crop } = slide;
    const step = KEY_PAN * (e.shiftKey ? 5 : 1);
    let next = null;
    switch (e.key) {
      case "ArrowLeft":
        next = { ...crop, x: crop.x - crop.w * step };
        break;
      case "ArrowRight":
        next = { ...crop, x: crop.x + crop.w * step };
        break;
      case "ArrowUp":
        next = { ...crop, y: crop.y - crop.h * step };
        break;
      case "ArrowDown":
        next = { ...crop, y: crop.y + crop.h * step };
        break;
      case "+":
      case "=":
        next = this._zoomCrop(crop, 1 / KEY_ZOOM);
        break;
      case "-":
      case "_":
        next = this._zoomCrop(crop, KEY_ZOOM);
        break;
      default:
        return;
    }
    e.preventDefault?.();
    this._refocus = i;
    this._commitCrop(i, next);
  }
}
