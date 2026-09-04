# Carousel Studio

An SCRL-like Instagram carousel builder for the admin: turn a post's media into a
designed, Instagram-ready slide deck — crop, aspect, order, continuity across slides,
and (later) text and reusable canvas templates.

Point already cross-posts a post's photos to Instagram as a ≤20-image carousel
(`api/internal/services/post_publish.go` driving `instagram_service.go`). What is
missing is **composition**: it ships whatever aspect the originals happen to be, in
whatever order the database returns them, with no crop and no text. Carousel Studio
adds that layer. The publish half already exists, so each stage lands on working
infrastructure.

## Status

Staged delivery. As of 2026-09: the **output contract** below is pinned (a Go render
test), the editor's Visual mode preserves a `:::{.carousel-block}` fence (C3), the
`carousel` plugin exists as a gated skeleton — registry descriptor, an empty studio
shell at `/light/carousel?post=<id>`, and a post-editor menu entry (C4) — and the pure
`geometry.js` / `document.js` modules with their unit tests have landed (C5), and the
`carousels` table with its `GET/PUT/DELETE /api/carousel?post=<id>` document API is
wired and gated (C6). The splitter MVP is live (C7) — the studio picks one image,
slices it into 2–20 equal 4:5 / 1:1 / 1.91:1 slides through a thin browser-canvas
`render.js`, uploads each as a post-owned media file, saves the document, and writes
the `:::{.carousel-block}` into post content. Re-render cleanup and Instagram
slide selection have landed (C8) — a re-render deletes the superseded slide
rows, a post with a carousel block cross-posts *those slides* and nothing else,
and byte-identical slides are refused in the studio. The public block now has
its own style (C9) — `frontend/css/public/carousel-block.css`, a scroll-snap
strip of slides in the article view, and `postMedia.js` expands the block into
one media item per slide for the immersive viewer — where stepping between two
slides of one deck pans instead of crossfading, so the seam reads as a single
image. Framing, layers and templates (S2–S5) are not built yet. See
"Delivery stages".

Ahead of S2, `geometry.js` gained the inverse of the split question — `fitReport`
and `slideCountOptions` say how many slides a source makes and at what scale
(`cover` resamples to fill; `exact`/`pad` stay pixel-for-pixel), and `sliceRects`
takes a `{ strategy, anchorY }` option and rounds every column edge to a whole
source pixel so the next layer can crop per slide with `createImageBitmap`. The
4-argument `sliceRects` call is unchanged.

## The output contract

Slides are written into post content as a fenced div of bare media paths:

```
:::{.carousel-block}

/2026/08/slide-1.jpg

/2026/08/slide-2.jpg

:::
```

This renders — through the **existing** markdown pipeline, with no carousel-specific
code — to:

```html
<div class="carousel-block">
<p><img src="/2026/08/slide-1.jpg" alt="slide-1.jpg" loading="lazy" decoding="async"></p>
<p><img src="/2026/08/slide-2.jpg" alt="slide-2.jpg" loading="lazy" decoding="async"></p>
</div>
```

Pinned by `TestRenderContent_CarouselBlock` in
`api/internal/services/post_render_carousel_test.go`. What makes it work:

- `preprocessContent` (`post_render.go`) expands bare `/YYYY/MM/…` paths with a
  multiline-anchored regex, so paths *inside* a `:::` fence are expanded too.
- goldmark-fences + goldmark-attributes are wired in `newPostMarkdown`; bluemonday
  allows `div` + `class` in `newPostPolicy`.
- `ExtractMediaPaths` (`media_service.go`) uses an *unanchored* regex, so the
  visibility rule and the Instagram publish path both find slides inside the fence —
  no second writer to `media.is_public`.

**Blank line between paths is mandatory.** `html.WithHardWraps()` is enabled
(`post_render.go`), so consecutive bare paths collapse into one `<p>` joined by `<br>`
instead of one `<p>` per image. The block writer must emit the blank-line form.
Pinned by `TestRenderContent_CarouselBlock_BlankLineContract`.

If this contract ever breaks, the fix is to emit the `<div>` and `<img>` tags
directly from the block writer rather than relying on markdown expansion — and this
doc, plus the epic, must be updated.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Packaging | New `carousel` plugin, `DefaultEnabled: false` | Useful without Meta credentials (blog carousel, download); grows an Instagram affordance when the `instagram` plugin is also on |
| Renderer | Browser Canvas 2D only | Zero new Go deps; the binary is CGO-free and `imaging` has no text rasterizer. Precedent: `frontend/src/utils/videoPoster.js` |
| Output contract | `:::{.carousel-block}` fenced div of bare paths written into post content | Media goes public through the *existing* visibility rule — privacy-critical sync code is untouched |
| Block class | `.carousel-block`, **not** `.carousel` | `frontend/css/public/carousel.css` owns the `.carousel-*` namespace for the lightbox/immersive viewer and bundles into `viewer.css` |
| Public block CSS | New partial appended to the **main** bundle list in `build-css.sh`, not the plugin dir | Plugin CSS is served only when the plugin is enabled; published content must stay styled with the plugin off. Only the admin studio CSS belongs in the plugin dir |
| UI surface | Full-page admin route `/light/carousel?post=<id>` | A filmstrip + stage + properties panel does not fit a `<details>` field group. Param-less path: plugin routes are merged verbatim and filtered on `startsWith("/light")` (`app.js`) |
| Document storage | New `carousels` table keyed `post_id UNIQUE` | sqlc expands `SELECT *`; a multi-KB JSON blob on `posts` would ride along on every post-list query |
| Superseded slides on re-render | Studio deletes the prior generation's `rendered[].media_id` rows explicitly, skipping any path still elsewhere in the post | Slides carry a `post_id`, so `ListOrphanedMedia` (`post_id IS NULL`) never flags them — without an explicit delete every re-render leaks the old slides onto disk forever. Widening orphan detection into a content scan is a media-library change and out of scope |
| A post with a carousel block on Instagram | The block's slides ARE the carousel — the post's other loose photos are dropped, then the ≤20 truncation still applies | A designed deck plus whatever else the post shows is not what the author composed; `post_publish.go` picks `carouselBlockPaths` over the full `ExtractMediaPaths` set when a fence is present |
| Grid thumbnail of a post whose first media is a carousel | Slide 1 becomes the post's `media_url` — kept, not worked around | `DeriveMediaURL` (`api/internal/utils/media.go`) takes the first bare media path in content, and the fence emits bare paths, so a carousel at the top of a post makes its cover slide the grid thumbnail. That is the right thumbnail for a designed deck. A post that wants a different thumbnail sets `thumbnail_path` explicitly, which still wins |
| Immersive step between two deck slides | Pan, don't crossfade — both slices held at full opacity while they translate | The studio splits one photo into continuity-matched slices; the shared `MediaViewer` crossfade drops the outgoing slice to `opacity: 0`, flashing the backdrop through the seam. `postMedia.js` marks expanded slides `carousel: true`; `MediaViewer._seamlessPair` gates a translate-only step (`_seamlessStep`) and holds opacity on drag/commit. Non-deck media is untouched |
| Byte-identical slides | Refused in the studio with a clear message | They dedup to one media row (SHA256) and one path, which the blog's `extractMedia` renders twice while Go's `ExtractMediaPaths` dedups to one Instagram child — the two would disagree. Rejecting the render is simpler than de-duping at two display sites, and a carousel with two identical slides has no purpose |

### The carousel document

One JSON document per post in `carousels.doc` is the source of truth; the
`:::{.carousel-block}` in post content is its *rendered output*, regenerated on each
render.

```jsonc
{
  "version": 1,
  "aspect": "4:5",              // 4:5 (1080x1350) | 1:1 | 1.91:1
  "mode":   "split",            // split: one source across slides / deck: one per slide
  "slides": [{
    "source": "/2026/08/x.jpg",
    "crop":   { "x": 0, "y": 0, "w": 0.333, "h": 1 },   // normalized to source
    "fit":    "cover",                                   // cover | contain
    "bg":     { "type": "blur" },
    "layers": [ /* text | image | rect | counter | arrow */ ],
    "rendered": { "path": "…", "media_id": 42, "specHash": "…" }
  }],
  "spanLayers": [ /* canvas-space, across all slides */ ],
  "template":   { "id": "cover-3-cta", "custom": false }
}
```

The predefined-canvas (S4) template format is this same schema with placeholder
values — stated up front so S4 cannot rewrite S2/S3. `rendered[].media_id` lets the
document delete its own superseded slide rows: orphan detection is `post_id IS NULL`
(`queries_media.go`), so slides uploaded with a `post_id` are never flagged, and
`ListOrphanedMedia` is deliberately **not** widened into a content scan.

## Considered and rejected

| Alternative | Why rejected |
|---|---|
| **Go-side compositing** (render slides on the server with `disintegration/imaging`) | The binary is CGO-free and `imaging` has no text rasterizer, so slide text — the whole point past S1 — is impossible. Would also add a heavy image dependency for work the browser already does. Canvas 2D in the admin has full font access and zero new deps. |
| **Slides as a new media type / kind column** | Slides are ordinary images once rendered; a new type means teaching every media query, filter, and the library UI about it. The document's `rendered[].media_id` tracks provenance without a schema-wide concept. |
| **A new goldmark AST node + renderer for carousels** | The `:::{.carousel-block}` fence already renders correctly through goldmark-fences + goldmark-attributes (pinned above). A custom node is code to maintain for output the generic path already produces, and it would diverge from how `::: {.hero}` and other attribute fences work. |
| **A "carousels are not in content" model** (block lives only in the `carousels` table, injected at render) | Needs a second writer to `media.is_public` to publish slide media, duplicating the privacy-critical visibility logic. Writing the fence into post content reuses the one existing rule (`ExtractMediaPaths` → visible published post → public media). Also breaks RSS, search indexing, and the plain-markdown export. |
| **A JSON blob column on `posts`** | sqlc `SELECT *` would carry a multi-KB document on every post-list query. Separate `carousels` table, keyed `post_id UNIQUE`. |
| **A custom-template editor** (S5) | Turns a publishing tool into a design tool. If custom templates ship at all, ship JSON import/export, not an editor. |

## Delivery stages

C1–C9 are tracked as beads under the Carousel Studio epic; later stages (S2–S5) are
**not** scheduled until C1–C9 land, because C5/C6's schema decisions determine whether
they are extensions or rewrites.

| Stage | Scope |
|---|---|
| **C1** | Fix Instagram carousel slide order (reorder `GetMediaByPaths` output by `ExtractMediaPaths` order). Ships standalone — a live bug. |
| **C2** | This doc + the fence render contract test. |
| **C3** | `postNodes.js` + `VisualEditor.js` carousel node — line-based parse ahead of `IMAGE_PATH_RE`, serialize in both, round-trip tests. Data-loss guard: today, opening a carousel post in Visual mode and saving destroys the block. Must precede any writer. |
| **C4** | Plugin skeleton: `registry.go` descriptor, `frontend/src/plugins/carousel/index.js`, post-editor menu entry, gating tests (chunk + `/api/carousel` 404 when off). |
| **C5** | Pure `geometry.js` + `document.js` + unit tests. No UI, no canvas. **Done** — `frontend/src/plugins/carousel/{geometry,document}.js`, `frontend/test/carousel{Geometry,Document}.test.js`. |
| **C6** | `carousels` table + migration + repo queries + handler + JS API client + Go tests. **Done** — `carousels(post_id UNIQUE)`, sqlc `GetCarouselByPostID` / `UpsertCarousel` / `DeleteCarouselByPostID`, `api/internal/api/carousel.go`, `frontend/src/api/carousel.js`. `doc` is stored and returned verbatim (validated only as a JSON object); `?post=<id>` on every verb; all 404 with the plugin off; post delete cascades. |
| **C7** | Splitter MVP: source picker, N/aspect controls, safe-area guides, thin `render.js`, `createImageBitmap` downscale, upload, write block, save document. **Done** — `frontend/src/plugins/carousel/{index,render}.js`, `document.js` gains `splitDocument` / `applyCarouselBlock`, tests in `frontend/test/carousel{Render,Document,StudioPage}.test.js`. |
| **C8** | Superseded-slide cleanup on re-render; "carousel block wins" + the >20 rule in `post_publish.go`; resolve the duplicate-path divergence between Go (`ExtractMediaPaths` dedups) and the browser (`extractMedia` does not). **Done** — `index.js` `_render` deletes superseded `media_id`s and refuses byte-identical slides; `post_publish.go` `carouselBlockPaths` selects the fence's slides; see the Decisions rows above. |
| **C9** | Public block CSS partial; verify non-immersive and immersive rendering, including `mediaFromHtml` expansion in the immersive viewer. **Done** — `frontend/css/public/carousel-block.css` appended to the **main** bundle list in `build-css.sh` (not the plugin chunk); `mediaFromHtml` (`postMedia.js`) expands a `<div class="carousel-block">` into its N media items on the `<hr>` path and marks each `carousel: true`; the immersive `MediaViewer` pans between same-deck slides rather than crossfading (see Decisions); grid-thumbnail behaviour recorded below. |
| **S2** | Framing — per-slide pan/zoom, cover/contain, background fill, `deck` mode. |
| **S3** | Layers — per-slide and canvas-space spanning layers, text with wrap/auto-fit, logo, counters. Uses the active theme's font stack, **not** bundled WOFF2 (`docs/vendors.md`). |
| **S4** | Predefined canvases as JSON in the repo; placeholders reuse the caption-template vocabulary (`{title}`, `{excerpt}`, `{tags}`, `{link}`). |
| **S5** | Production — caption composer, one-click push, brand kit scoped to 2–3 settings rows. |

## Out of scope

- Server-side slide rendering (see rejected alternatives).
- A custom-template editor (S5 note).
- Video / Reels slides — the Instagram publish path is image-only (`instagram-integration.md`).
- Changing the media library or `ListOrphanedMedia` to understand generated slides — the document tracks its own `media_id`s.

## Prove it

```bash
cd api && go test ./internal/services/ -run Render
./scripts/check-docs.sh
```
