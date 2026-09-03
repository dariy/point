/**
 * Carousel Studio — the admin slide-builder shell.
 *
 * Route: /light/carousel?post=<id>. The path carries no `:id` because plugin
 * admin routes are merged verbatim from the manifest and filtered on the
 * `/light` prefix, and the page title is derived from the last path segment
 * (frontend/src/app.js) — a `:postId` segment would title the page ":postId".
 * The target post arrives as a query param instead.
 *
 * The MVP (C7) is the splitter: pick one image, choose a slide count and an
 * aspect, and slice it into equal columns that read as one continuous picture
 * when swiped. The heavy lifting is split three ways —
 *   - `geometry.js`  the pure math (strip crop, column rects, safe area)
 *   - `render.js`    the thin draw layer (decode → drawImage → encode → upload)
 *   - `document.js`  the carousel document + its `:::{.carousel-block}` output
 * — and this file is the chrome that drives them. Framing, layers and
 * templates land in later stages (see docs/features/carousel-studio.md).
 */

import { Component } from "../../components/Component.js";
import {
  adminLayoutTemplate,
  setupAdminLayout,
} from "../../components/light/AdminLayout.js";
import { MediaPickerDialog } from "../../components/light/MediaPickerDialog.js";
import { getPost, updatePost } from "../../api/posts.js";
import { getCarousel, saveCarousel } from "../../api/carousel.js";
import { setToast } from "../../store.js";
import { html, raw } from "../../utils/helpers.js";
import { REFRESH_SVG } from "../../utils/icons.js";
import { canvasSize, safeAreaRect } from "./geometry.js";
import {
  applyCarouselBlock,
  emptyDocument,
  parseDocument,
  specHash,
  splitDocument,
} from "./document.js";
import { browserDeps, renderAndUpload } from "./render.js";

/** Slide-count bounds — Instagram tops out at 10 images per carousel. */
const MIN_SLIDES = 2;
const MAX_SLIDES = 10;
const DEFAULT_SLIDES = 3;

const ASPECT_OPTIONS = [
  ["4:5", "Portrait 4:5"],
  ["1:1", "Square 1:1"],
  ["1.91:1", "Landscape 1.91:1"],
];

/** The post id from `?post=`, or null when absent/malformed. */
function readPostId(query) {
  const raw = /** @type {{ post?: string }} */ (query || {}).post;
  return raw != null && /^[0-9]+$/.test(String(raw)) ? Number(raw) : null;
}

/** A picked media item is usable as a split source only if it is an image. */
function isImagePath(path) {
  return typeof path === "string" && !/\.(mp4|mov|webm|m4v|avi)$/i.test(path);
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
      source: "",
      n: DEFAULT_SLIDES,
      aspect: "4:5",
      showGuides: true,
      busy: false,
      rendered: [],
    };
    this._picker = null;
  }

  actions = {
    "pick-source"() {
      this._openPicker();
    },
    render() {
      this._render();
    },
  };

  mount() {
    super.mount();
    this._load();
  }

  beforeUnmount() {
    this._picker?.destroy();
    this._picker = null;
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
      const first = doc.slides[0];
      this.setState({
        loading: false,
        post,
        source: first ? first.source : "",
        n: doc.slides.length >= MIN_SLIDES ? doc.slides.length : DEFAULT_SLIDES,
        aspect: doc.aspect || "4:5",
        rendered: doc.slides
          .map((s) => s.rendered && s.rendered.path)
          .filter(Boolean),
      });
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
          if (img) this.setState({ source: img.path, rendered: [] });
        },
      });
      this._picker.mount();
    }
    this._picker.open();
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

  async _render() {
    const { postId, post, source, n, aspect } = this.state;
    if (!source || this.state.busy) return;

    this.setState({ busy: true, error: null });
    try {
      const deps = this.props.renderDeps || browserDeps();
      const doc = splitDocument({ source, n, aspect });
      const media = await renderAndUpload({ source, n, aspect, postId }, deps);
      media.forEach((m, i) => {
        doc.slides[i].rendered = {
          path: m.path,
          media_id: m.id,
          specHash: specHash(doc.slides[i], aspect),
        };
      });
      await saveCarousel(postId, doc);
      const content = applyCarouselBlock(post.content, doc);
      const updated = await updatePost(postId, this._postPayload(post, content));
      if (this._unmounted) return;
      this.setState({
        busy: false,
        post: { ...post, content: updated?.content ?? content },
        rendered: media.map((m) => m.path),
      });
      setToast({ message: `Carousel rendered — ${media.length} slides.`, type: "success" });
    } catch (err) {
      if (this._unmounted) return;
      this.setState({ busy: false, error: err?.message || "Render failed." });
      setToast({ message: `Carousel render failed: ${err?.message || err}`, type: "error" });
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
    const { source, busy } = this.state;
    return html`
      <button
        id="carousel-render-btn"
        class="btn btn-primary"
        data-action="render"
        ${!source || busy ? "disabled" : ""}
      >
        ${raw(REFRESH_SVG)}<span class="btn-label">${busy ? "Rendering…" : "Render"}</span>
      </button>`;
  }

  _renderStudio() {
    const { loading, error, postId, source } = this.state;
    const lead = html`
      <p class="carousel-studio__lead">
        Building slides for
        <a href="/light/posts/${String(postId)}/edit">this post</a>.
      </p>`;

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
        ${source ? this._renderBuilder() : this._renderPickPrompt()}
      </section>`;
  }

  _renderPickPrompt() {
    return html`
      <div class="carousel-studio__pick">
        <p>Pick one image to slice into slides.</p>
        <button class="btn btn-primary" data-action="pick-source">Choose image</button>
      </div>`;
  }

  _renderBuilder() {
    const { n, aspect, showGuides, rendered } = this.state;
    const [w, h] = canvasSize(aspect);

    const dividers = Array.from({ length: n - 1 }, (_, i) => {
      const left = ((i + 1) / n) * 100;
      return html`<span class="carousel-studio__divider" style="left:${String(left)}%"></span>`;
    });

    const sa = safeAreaRect(aspect);
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

    const strip = Array.from({ length: n }, (_, i) => {
      const posX = n > 1 ? (i / (n - 1)) * 100 : 0;
      return html`
        <div
          class="carousel-studio__frame"
          data-slice="${String(i)}"
          style="aspect-ratio:${String(w)}/${String(h)};background-position:${String(posX)}% 50%;background-size:${String(n * 100)}% 100%"
        ></div>`;
    });

    const renderedStrip = rendered.length
      ? html`
          <div class="carousel-studio__rendered">
            <h2 class="carousel-studio__subhead">Rendered slides</h2>
            <div class="carousel-studio__slides">
              ${rendered.map(
                (p) => html`<img class="carousel-studio__slide" src="${p}" alt="" loading="lazy" />`,
              )}
            </div>
          </div>`
      : "";

    return html`
      <div class="carousel-studio__builder">
        <div
          class="carousel-studio__stage"
          style="aspect-ratio:${String(n * w)}/${String(h)}"
        >
          ${dividers}${guides}
        </div>

        <div class="carousel-studio__filmstrip" aria-label="Slide preview">${strip}</div>

        <div class="carousel-studio__controls">
          <label class="carousel-studio__control">
            <span>Slides: <output id="carousel-n-out">${String(n)}</output></span>
            <input
              type="range"
              id="carousel-n"
              min="${String(MIN_SLIDES)}"
              max="${String(MAX_SLIDES)}"
              value="${String(n)}"
            />
          </label>

          <label class="carousel-studio__control">
            <span>Aspect</span>
            <select id="carousel-aspect">
              ${ASPECT_OPTIONS.map(
                ([val, text]) => html`
                  <option value="${val}" ${val === aspect ? "selected" : ""}>${text}</option>`,
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

  afterRender() {
    setupAdminLayout(this, { currentPath: "/light/carousel" });

    // The source image drives both the stage and every filmstrip frame as a
    // CSS background — set from JS so a media path never lands in a style
    // string the html`` tag can only HTML-escape, not CSS-escape.
    const { source } = this.state;
    if (source) {
      const bg = `url("${encodeURI(source)}")`;
      const stage = this.$(".carousel-studio__stage");
      if (stage) stage.style.backgroundImage = bg;
      this.$$(".carousel-studio__frame").forEach((el) => {
        el.style.backgroundImage = bg;
      });
    }

    const nInput = /** @type {HTMLInputElement|null} */ (this.$("#carousel-n"));
    const nOut = this.$("#carousel-n-out");
    // Live readout while dragging; commit to state (and re-render the preview)
    // only on release, so the slider doesn't fight a rebuild mid-drag.
    this.on(nInput, "input", () => {
      if (nOut) nOut.textContent = String(nInput.value);
    });
    this.on(nInput, "change", () => {
      this.setState({ n: Number(nInput.value) });
    });

    this.on(this.$("#carousel-aspect"), "change", (e) => {
      this.setState({ aspect: /** @type {HTMLSelectElement} */ (e.target).value });
    });
    this.on(this.$("#carousel-guides"), "change", (e) => {
      this.setState({ showGuides: /** @type {HTMLInputElement} */ (e.target).checked });
    });
  }
}
