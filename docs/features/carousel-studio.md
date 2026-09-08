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

> **Two unrelated meanings of "deck".** `doc.mode: "deck"` is the *document*
> mode where every slide carries its own `source` and `crop`, as opposed to
> `"split"`, where all slides are derived from one source by `sliceRects`. The
> immersive viewer's *deck transition* — panning rather than crossfading between
> two slides of one rendered carousel block — is `MediaViewer._seamlessPair` /
> `_seamlessStep` (`frontend/src/components/shared/MediaViewer.js`), gated on the
> `carousel: true` flag `postMedia.js` sets. They are not connected, and neither
> should be renamed to match the other. A split-mode carousel gets the seamless
> pan (its slices continue each other); a deck-mode one gets it too, because the
> flag is set per block, not per mode — which is worth knowing, since slides cut
> from different photos have no seam to preserve.

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
image. Framing (S2) has landed — see "Deck mode and per-slide framing" below.
Layers and templates (S3–S5) are not built yet. See "Delivery stages".

Ahead of S2, `geometry.js` gained the inverse of the split question — `fitReport`
and `slideCountOptions` say how many slides a source makes and at what scale
(`cover` resamples to fill; `exact`/`pad` stay pixel-for-pixel), and `sliceRects`
takes a `{ strategy, anchorY }` option and rounds every column edge to a whole
source pixel. The 4-argument `sliceRects` call is unchanged. The studio surfaces
this in a fit panel: source pixel size, one-click count/strategy chips from
`slideCountOptions`, a Cover/Fill/Exact/Pad radio, a live `fitReport` readout
(scale, trimmed width, pad or full-bleed) with an upscale warning past 2% scale,
and a vertical-anchor slider shown only when the crop leaves vertical slack.
`strategy` (default `cover`) and `anchorY` (default `0.5`) are now doc-level
fields — additive, so `DOC_VERSION` stays 1 — and fold into `specHash` so a
strategy or anchor change invalidates a cached render. The source's own
`width`/`height` are not stored in the document; the studio re-probes them on
load (preferring the picked media item's own fields; falling back to an
`Image()` probe otherwise).

`render.js` acts on that: one `createImageBitmap(blob, sx, sy, sw, sh, { resizeWidth,
resizeHeight, resizeQuality })` **per slide**, cropping the column and resampling it
straight to the slide canvas, so the decoder holds a constant `slideW × slideH` RGBA
(~5.8 MB at 4:5) whatever the source megapixels or slide count — and the blit is 1:1,
so "pixel-exact" is honest (the old 4096px strip cap silently downscaled any deck of 4+
slides). The last `pad` slide's gap is filled from `slide.bg` (`blur` = the column
stretched under `ctx.filter`; `solid` = `fillRect`) before the blit. `renderSplit` takes
an optional `onProgress({ done, total })` fired after each slide. Cost: `n` JPEG decodes
instead of one — accepted.

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

## Sizing

`geometry.js` answers two questions about one source image and one target aspect:
"how many slides, and what happens to the pixels that don't divide evenly?" There
are three strategies, all cutting the same full-height band:

| Strategy | Slide count `n` | Scale | What happens to the remainder |
|---|---|---|---|
| `cover` (default) | whatever the caller/chip picks | `max(n·dstW/srcW, dstH/srcH)` — may up- or downscale | no remainder — the strip is resampled to fill every canvas exactly |
| `exact` | `floor(nExact)` | 1 (pixel-for-pixel) | `srcW − n·dstW` px of width trimmed off, split evenly off both sides |
| `pad` | `ceil(nExact)` | 1 (pixel-for-pixel) | the last slide's tail is flush left; the gap is filled from `slide.bg` (`blur`: the column stretched under `ctx.filter`; `solid`: `fillRect`) |

`nExact = srcW / dstW` — the continuous slide count the source would need to cover
at scale 1. `exact`'s `n` rounds it down (never split a source pixel across two
slides); `pad`'s rounds it up (never crop the source — the shortfall is padding
instead).

`exact` and `pad` are **pixel-exact** strategies: nothing is resampled, so a slide
is the source's own pixels, one-to-one. That is only possible when the source is
large enough — the feasibility rule `fitReport` checks is:

```
n · dstW <= srcW   AND   dstH <= srcH
```

i.e. the source must be at least as tall as one canvas, and at least as wide as
`n` canvases side by side. `sliceRects` falls back to `cover` whenever a caller
asks for `exact`/`pad` on a source that fails this — the studio itself never
offers an infeasible chip, because `slideCountOptions` drops any strategy whose
`fitReport` is infeasible before it reaches the UI. `cover` has no feasibility
condition — it always produces exactly the `n` requested, at whatever scale that
takes.

`anchorY` (0..1) places the crop band vertically within the slack a source taller
than `dstH` leaves behind — `(srcH - dstH) * anchorY` from the top, the same
formula for all three strategies. Horizontally, `cover`/`exact` centre the kept
strip; `pad` is always flush left from `x = 0`.

## Deck mode and per-slide framing

Everything above describes `split`: one source, one doc-level projection, every
slide a slave of it. `deck` (S2) is the other mode the schema always reserved —
each slide carries its own `source`, its own normalized `crop`, its own `fit`,
and its own background fill. That is what makes per-slide pan and zoom possible
at all, and it is the substrate S3's layers sit on.

**Split → deck is a one-way freeze, not a toggle.** `toDeckDocument(doc, srcW,
srcH)` (`document.js`) runs `sliceRects` once and writes each column back as the
slide's own `crop` (normalized against the source) plus a `fit` — `contain`
where the column had a `pad`, `cover` otherwise. Nothing on screen moves: the
deck starts as an exact restatement of the split projection, and only diverges
once the user edits a slide. Going back to split re-derives every slide from one
strip and **discards** all per-slide framing, so the studio confirms first.
Source pixel dimensions are arguments, never document fields — the document
stores no derived data, and the studio re-probes on load.

Two seams are visible in the freeze, both from a per-slide model meeting a
whole-strip one, and both are deliberate:

- **The `pad` strategy's tail slide is re-centred.** In split it sits flush left
  with its gap on the right, because it has to continue the column before it. A
  contained deck slide is centred by construction; deck mode has no horizontal
  alignment to express the alternative. The studio says so in a toast.
- **`cover` can land a source pixel off.** `deckSlideRects` re-derives the frame
  aspect from the rounded crop, so a column that was a rounded pixel off the
  exact ratio gets re-centre-cropped by up to 2px in `sw`/`sh` and 1px in
  `sx`/`sy`, always inside the split region, destination rect untouched.
  `exact`/`pad` are pixel-identical wherever the source can honour them.

### The Canvas/CSS geometry pair

`geometry.js` answers the framing question twice, from one private helper
(`deckSlideFrame`), because the studio needs the same numbers in two languages:

| Function | Returns | Consumed by |
|---|---|---|
| `deckSlideRects(srcW, srcH, aspect, crop, fit)` | the same 8-tuple `sliceRects` returns (`sx,sy,sw,sh,dx,dy,dw,dh`), plus `pad` | `render.js` → `createImageBitmap` + `drawImage` |
| `deckSlideFitCSS(srcW, srcH, aspect, crop, fit)` | `{size, position, box}` — percent pairs | `index.js` → `background-size` / `background-position` |

Both round to whole source pixels *in the shared helper*, not each in a formula
of its own — that is the whole point of the pair. `createImageBitmap`'s crop
arguments must be integers, and if the CSS preview rounded independently it
would lie about the render by a pixel. `deckSlideFitCSS` is derived from the
rects rather than from the crop, and computes its two axes independently, so it
reproduces the same non-uniform stretch `drawImage` applies when rounding leaves
`sw:sh` slightly off the frame ratio. This is the same relationship `sliceRects`
and `backgroundFit` already have for the split path.

`box` is not decoration. For `cover` it is the whole frame; for `contain` the
caller **must** honour it, because the CSS background is clipped to its element
and only an element cut down to the letterboxed content rect hides the source
outside the crop. The pad region is then simply the frame showing through — the
`_deckLayers()` fill span in `index.js` — which is exactly what the canvas
fills with `bg`.

**Live preview is CSS, never canvas.** A pan or a zoom writes two CSS properties
and nothing else; no `drawImage` and no `createImageBitmap` runs on pointermove.
That is what lets a gesture repaint at 60fps. Gestures are pointer-events based
(drag to pan, wheel or two-finger pinch to zoom, arrow keys to nudge, `+`/`-` to
zoom), and a wheel burst is committed to the document once, `WHEEL_COMMIT_MS`
after the last tick, because a wheel gesture has no release event.

**The document is the single source of truth.** `index.js` holds a `CarouselDoc`
and mutates it only through `document.js`. `updateSlideFraming(doc, i, update,
{srcW, srcH})` is the single writer for `crop` / `fit` / `bg`: it merges a
partial crop field by field (so a pan can send `{x, y}` without resetting the
zoom), passes it through `clampPan`, and returns a new document. An out-of-range
index or a rejected value returns an equal document rather than throwing —
this runs at gesture rate from pointer handlers, where a throw strands the drag.

### Background fill

`slide.bg` is what the render paints wherever the slide's own pixels do not
reach: a `contain` slide's letterbox, or the `pad` strategy's tail gap. Three
types, all fed to the same `paintSlide` loop:

| `bg.type` | Fields | Painted as |
|---|---|---|
| `blur` (default) | `radius?` | the slide's own pixels stretched across the frame under `ctx.filter = blur(...)`; radius defaults to 5% of canvas width |
| `solid` | `color` | `fillRect` per pad rect |
| `gradient` | `angle`, `stops[]` | one canvas gradient across the **whole frame**, clipped to the pad rects by the fills — so two letterbox bars read as ends of one gradient, not two |

`geometry.padRects(rect, dstW, dstH)` flattens the two `pad` shapes this module
produces into one list, which is what lets the split tail column and a deck
letterbox share a single draw path: `sliceRects` reports `pad: {x, w}` (always
full height), `deckSlideRects` reports `pad: [{x,y,w,h}, …]`, because a contained
slide is letterboxed on two opposite sides at once and one rect cannot say that.
An empty result means "paint no background at all". `paintSlide` measures
nothing itself — it is a pure call-issuer over `padRects` and `gradientLine`, so
a recording fake context can assert the exact call sequence.

`geometry.gradientLine(angleDeg, w, h)` follows the CSS `linear-gradient(<angle>)`
convention exactly — `0deg` to the top, clockwise, line length
`|w·sin a| + |h·cos a|` centred — because the studio's preview is a CSS gradient
on a DOM element and the render is a canvas gradient. If they disagreed, the
preview would lie.

Colours are hex or `transparent` and nothing else — deliberately narrower than
CSS, because a stop reaches `CanvasGradient.addColorStop`, which *throws* on a
string it cannot parse. Rejecting in `normalizeBg` keeps a bad background a
normalization problem rather than a mid-encode exception. `blur` is stored as
`bg: null`: it is the render's default, and writing it explicitly would change
the slide's `specHash` without changing a pixel.

### Rendering a deck

`renderCarousel(doc, deps, onProgress, keep, opts)` is the facade — the one
entry point callers use, so the studio never branches on `doc.mode` itself. It
dispatches to `renderDeck` or adapts the document into the flat `SplitSpec`
`renderSplit` has taken since S1 (the split path's behaviour is unchanged; the
background comes from the **last** slide, the only one `sliceRects` can pad).
`paintSlide` and `encodeSlide` are the shared deterministic core: a split slide
and a deck slide are produced by literally the same calls in the same order.

`renderDeck` fetches and probes **once per distinct source path**, however many
slides name it. A deck frozen from a split names one image on all N slides, so
without the dedup an eight-slide deck would issue eight identical GETs and eight
probes. The cache holds the *compressed* blob, not a decoded bitmap — that is
what makes it safe to hold for the whole render, since the constant-memory
promise is about decoded RGBA and `encodeSlide` still keeps exactly one of those
alive at a time. It is lazy too: a deck whose every slide is in `keep` touches
the network not at all. `opts.srcW`/`srcH` seed the probe only when every slide
shares one source; with two sources in play the caller's dimensions would be
ambiguous, so each is probed.

### What the studio does not yet offer

The renderer and the schema support a deck built from N different photos — that
is what the per-source dedup in `renderDeck` exists for. The **studio UI does
not**: picking an image in deck mode swaps the source on every slide at once
(keeping the per-slide crops, which are normalized and so stay valid). A
per-slide source picker is the obvious next increment and is not part of S2.
The background control is shown only for a slide that actually has a letterbox
to fill — offering a fill that paints nothing is worse than offering none — and
the gradient control edits two ends only, so a hand-authored document with three
or more stops loses the middle ones the moment that panel writes.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Slide decode | One `createImageBitmap(blob, sx, sy, sw, sh, {resizeWidth, resizeHeight, resizeQuality})` crop+resize decode **per slide**, not one decode of a single strip | A strip wide enough for the whole deck at source resolution could exceed browser canvas/bitmap limits, so the old code capped it at `MAX_STRIP_WIDTH = 4096px` and downscaled anything wider — silently, and only past 4 slides at typical source widths, so "pixel-exact" was a lie for exactly the decks where it mattered most. Per-slide decode holds a constant `slideW × slideH` RGBA buffer (~5.8 MB at 4:5) regardless of source megapixels or slide count, and the crop is genuinely 1:1. Cost: `n` JPEG decodes instead of one, and `MAX_STRIP_WIDTH`/`stripWidth` are gone from the codebase — accepted, and nothing in this doc should assume they still exist |
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
| Immersive step between two deck slides | Pan, don't crossfade — both slices held at full opacity, each translating by *its own image width* under a clip-path at the letterbox margin | The studio splits one photo into continuity-matched slices; the shared `MediaViewer` crossfade drops the outgoing slice to `opacity: 0`, flashing the backdrop through the seam, and a full-viewport translate opens a two-margin gap between them. `postMedia.js` marks expanded slides `carousel: true`; `MediaViewer._seamlessPair` gates it, `frontend/src/utils/deckTransition.js` does the geometry, and an equal-width guard falls back to the legacy pan. Non-deck media is untouched — see "Transitions" in [immersive.md](immersive.md) |
| Split → deck | A **one-way freeze**, not a two-way toggle of equal footing | `toDeckDocument` derives per-slide crops from `sliceRects`, so the visual output is identical until the user edits something — the freeze costs nothing to enter. The reverse direction genuinely destroys work (every hand-set crop, fit and fill), so it is a confirmed action, not a chip |
| Where deck framing math lives | `geometry.js`, as a Canvas/CSS pair (`deckSlideRects` + `deckSlideFitCSS`) over one private rounding helper | The two must agree to the pixel or the preview lies about the render, and the only way to guarantee that is one rounding site. Also keeps pixel arithmetic out of the gesture handlers: `index.js` records normalized intent and `geometry.js` resolves what it means on screen. Same relationship `sliceRects`/`backgroundFit` already had |
| Live pan/zoom preview | CSS `background-size`/`background-position`, never a canvas redraw | A `drawImage`/`createImageBitmap` on every pointermove cannot hold 60fps at source resolution, and the CSS pair is exactly what `applyBg` already consumed. The canvas is reserved for the one render that produces bytes |
| Studio state | The `CarouselDoc` **is** the state; every mutation goes through `document.js` | S1 held `n`/`strategy`/`anchorY`/`source` as loose component fields and rebuilt a doc at render time. Parallel UI state that must later be reconciled into a document is what per-slide framing makes untenable — one writer (`updateSlideFraming`) means a gesture cannot leave the renderer and the preview reading different numbers |
| Source pixel dimensions | Arguments to `toDeckDocument` / `updateSlideFraming` / `renderDeck`, never document fields | The document stores no derived data (S1 already re-probes on load). A stored `srcW` goes stale the moment the source is replaced, and nothing would notice |
| Deck source fetches | Deduplicated per path inside `renderDeck`, caching the compressed blob | The common deck names one image on all N slides, so the naive path is N identical GETs and N probes. Caching the blob (not a bitmap) keeps the constant-decoded-memory promise intact |
| `blur` background | Stored as `bg: null`, not `{type:"blur"}` | It is the render's default; writing it explicitly changes `specHash` without changing a pixel, which would re-encode and re-upload every slide for nothing |
| Gradient colours | Hex or `transparent` only — narrower than CSS | The stop reaches `CanvasGradient.addColorStop`, which throws on anything it cannot parse. Rejecting at normalization keeps a bad background a document problem, not a mid-encode exception |
| Background control visibility | Shown only for a slide whose `deckSlideRects` actually reports a `pad` | Asked and answered from the same call `paintSlide` uses, so the control cannot disagree with the render. A `cover` slide covers its frame; a fill that paints nothing is worse than no control |
| Byte-identical slides | Refused in the studio with a clear message | They dedup to one media row (SHA256) and one path, which the blog's `extractMedia` renders twice while Go's `ExtractMediaPaths` dedups to one Instagram child — the two would disagree. Rejecting the render is simpler than de-duping at two display sites, and a carousel with two identical slides has no purpose |

### The carousel document

One JSON document per post in `carousels.doc` is the source of truth; the
`:::{.carousel-block}` in post content is its *rendered output*, regenerated on each
render.

```jsonc
{
  "version": 1,
  "aspect":    "4:5",           // 4:5 (1080x1350) | 1:1 | 1.91:1
  "mode":      "split",         // split: one source across slides / deck: one per slide
  "strategy":  "cover",         // split only: cover (resample) | exact | pad — see geometry.sliceRects
  "anchorY":   0.5,             // split only: 0..1, vertical placement of the crop band in its slack
  "slides": [{
    "source": "/2026/08/x.jpg",
    "crop":   { "x": 0, "y": 0, "w": 0.333, "h": 1 },   // deck: normalized to source, what pan/zoom edits
    "fit":    "cover",                                   // deck: cover | contain
    "bg":     null,                                      // deck: null = blur (the default) — see below
    "layers": [ /* S3: text | image | rect | counter | arrow */ ],
    "rendered": { "path": "…", "media_id": 42, "specHash": "…" }
  }],
  "spanLayers": [ /* S3: canvas-space, across all slides */ ],
  "template":   { "id": "cover-3-cta", "custom": false }
}
```

`slides[].bg` is one of exactly three shapes, or `null`:

```jsonc
null                                              // blur at the default radius
{ "type": "blur",  "radius": 54 }                 // radius > 0 only; dropped otherwise
{ "type": "solid", "color": "#000000" }           // hex (3/4/6/8 digits) or "transparent"
{ "type": "gradient", "angle": 180,               // 0..359, CSS linear-gradient convention
  "stops": [ { "at": 0, "color": "#000000" },     // >= 2 stops, `at` 0..1
             { "at": 1, "color": "#2b2b2b" } ] }
```

`crop` / `fit` / `bg` are read in `deck` mode only; in `split` they are inert
except for the last slide's `bg`, which fills the `pad` strategy's tail gap.
Every field is normalized on the way in by `document.js` — unknown fields
dropped, out-of-range numbers clamped, an unusable gradient degraded to the
default rather than thrown — and `normalizeDocument` is idempotent, which is
what makes parse/serialize a round trip. `DOC_VERSION` is still `1`: everything
S2 added was already reserved in the schema or is additive.

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
| **One unified draw-rect type with a single optional `pad: {x, w}`** (the S2 design sketch's `SlideDrawRects`) | A `contain` slide is letterboxed on two opposite sides at once — left+right *or* top+bottom — which one rect cannot describe. Rather than widen the split path's `{x, w}` and force it to carry `y`/`h` it never varies, the two producers keep their natural shapes and `geometry.padRects` flattens both into the one list the draw layer fills. `paintSlide` still has a single loop. |
| **A two-way `split` ⇄ `deck` toggle that preserves both projections** | Would mean keeping the doc-level `strategy`/`anchorY` *and* per-slide crops simultaneously meaningful, with a rule for which wins — the parallel-state problem the document-as-truth decision exists to kill. The freeze is one-way and the reverse is destructive-and-confirmed instead. |

## Delivery stages

C1–C9 are tracked as beads under the Carousel Studio epic. U1–U6 are a
sizing-and-studio-UX pass that landed after C9, ahead of S2 — `anchorY` (vertical crop
placement) landed there rather than in S2, so S2 narrowed to per-slide pan/zoom on
**both** axes plus cover/contain, background fill and `deck` mode. S2 is done; S3–S5
remain, and C5/C6's schema held for S2 without a version bump, which is the evidence
that they are extensions rather than rewrites.

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
| **U1** | `fitReport` + `slideCountOptions` in `geometry.js`: given a source and target aspect, how many slides at what cost. **Done** — see "Sizing" above; `sliceRects` gains `{strategy, anchorY}`, column edges rounded to whole source pixels. |
| **U2** | Per-slide crop decode, `MAX_STRIP_WIDTH` removed. **Done** — see the Decisions row above. |
| **U3** | Fit panel: source pixel size, count/strategy chips, live `fitReport` readout, upscale warning, `anchorY` slider. **Done** — `strategy`/`anchorY` are additive doc-level fields (`DOC_VERSION` stays 1) folded into `specHash`; `MAX_SLIDES` raised 10 → 20. |
| **U4** | Filmstrip + stage preview computed from the same numbers `sliceRects` renders from, replacing a `background-size: cover` guess that only agreed with the `cover` strategy. **Done** — `exact`/`pad` now preview truthfully, including the padded region as a distinct hatched block. |
| **U5** | Render lifecycle: progress (`onProgress({done,total})`), dirty-state badge when slide count/aspect/strategy/anchorY drift from the saved document, `specHash`-gated skip of unchanged slides, a confirmed remove-carousel action, and upload cleanup on a mid-loop failure. **Done**. |
| **U6** | Open Carousel Studio from the Visual editor's read-only carousel card (today: post-editor overflow menu only), and a clearer way back to the post. Navigation only — no render-contract, schema, or editing-surface change. |
| **S2** | Framing — per-slide pan/zoom, cover/contain, background fill, `deck` mode. **Done** — `geometry.js` gains the `deckSlideRects`/`deckSlideFitCSS` Canvas/CSS pair plus `padRects`/`gradientLine`; `document.js` gains `toDeckDocument` (one-way freeze) and `updateSlideFraming` (the single framing writer); `render.js` gains the `renderCarousel` facade and `renderDeck` with per-source fetch dedup; `index.js` becomes doc-as-state with CSS-only pan/zoom preview and a per-slide fill picker. Tests in `frontend/test/carousel{Geometry,Document,Render,StudioPage}.test.js`. Multi-source decks are supported by the schema and renderer but not yet by the picker UI — see "What the studio does not yet offer". |
| **S3** | Layers — per-slide and canvas-space spanning layers, text with wrap/auto-fit, logo, counters. Uses the active theme's font stack, **not** bundled WOFF2 (`docs/vendors.md`). |
| **S4** | Predefined canvases as JSON in the repo; placeholders reuse the caption-template vocabulary (`{title}`, `{excerpt}`, `{tags}`, `{link}`). |
| **S5** | Production — caption composer, one-click push, brand kit scoped to 2–3 settings rows. |

## Out of scope

- Server-side slide rendering (see rejected alternatives).
- A custom-template editor (S5 note).
- Video / Reels slides — the Instagram publish path is image-only (`instagram-integration.md`).
- Changing the media library or `ListOrphanedMedia` to understand generated slides — the document tracks its own `media_id`s.
- A Plugins-page settings affordance for `carousel`: it appears in neither `PLUGIN_SETTINGS` nor `SETTINGS_PAGE_PATHS` (`frontend/src/pages/light/PluginsPage.js`), so today the plugin toggle has no settings drawer/link. S5's brand kit is what will need one.

## Prove it

```bash
cd api && go test ./internal/services/ -run Render
./scripts/check-docs.sh
```
