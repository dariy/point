# Carousel Studio

An SCRL-like Instagram carousel builder for the admin: turn a post's media into a
designed, Instagram-ready slide deck — crop, aspect, order, continuity across slides,
text and logo layers, and (later) reusable canvas templates.

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
Layers (S3) have landed — five layer types over a slide's canvas, the deck-space
`spanLayers` that run through the seams, painting inside `paintSlide`, and a
studio surface with a layer panel, a per-type property form and drag/resize/snap
on the stage; see "Layers" below. The editing surface caught up in S6 — the
stage stopped being a read-only picture and became the thing every gesture acts
on, the filmstrip demoted to a slide rail, the studio gained undo/redo and the
ability to add, remove, duplicate and reorder slides, the vertical anchor became
a drag, and the preview now runs the render's own typesetter; see "The stage is
the editor" below. Templates and production (S4–S5) are not built
yet. See "Delivery stages".

Ahead of S2, `geometry.js` gained the inverse of the split question — `fitReport`
and `slideCountOptions` say how many slides a source makes and at what scale
(`cover` resamples to fill; `exact`/`pad` stay pixel-for-pixel), and `sliceRects`
takes a `{ strategy, anchorY }` option and rounds every column edge to a whole
source pixel. The 4-argument `sliceRects` call is unchanged. The studio surfaces
this in a fit panel: source pixel size, one-click count/strategy chips from
`slideCountOptions`, a Cover/Fill/Exact/Pad radio, a live `fitReport` readout
(scale, trimmed width, pad or full-bleed) with an upscale warning past 2% scale,
and a vertical-anchor control shown only when the crop leaves vertical slack —
a slider in U3, and since S6 a rail down the stage's left edge that the band
itself is dragged in (see "The stage is the editor").
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

`split` and `deck` are the *stored* values (`MODES`, `document.js`) and the words
this document uses throughout. The studio's chips say **Panorama** and
**Slides** — one wide photo cut across every slide, versus a photo per slide —
because that is the choice a user is making. The naming lives in `modeToggle`
(`studio/panels.js`) and nowhere else: no migration, one vocabulary in the code
and on disk.

**Split → deck is a one-way freeze, not a toggle.** `toDeckDocument(doc, srcW,
srcH)` (`document.js`) runs `sliceRects` once and writes each column back as the
slide's own `crop` (normalized against the source) plus a `fit` — `contain`
where the column had a `pad`, `cover` otherwise. Nothing on screen moves: the
deck starts as an exact restatement of the split projection, and only diverges
once the user edits a slide. Going back to split re-derives every slide from one
strip and **discards** all per-slide framing — and, since S6, says so in a toast
carrying an Undo rather than asking permission first: the switch is a document
write like any other, so it is one history step away (see "Undo and redo"). The
toast names what a multi-source deck loses, too, since a panorama is one photo
cut into columns and only the first slide's can survive the trip.
Source pixel dimensions are arguments, never document fields — the document
stores no derived data, and the studio re-probes on load. It probes **every
distinct source** the document names and caches the answer per path (`dims` in
`index.js`, read through `_dimsFor`), because a crop is fractions of its own
source and one slide's pixels cannot answer for another's. `srcW`/`srcH` stay
the document-level pair: the panorama's photo, slide 0's in Slides mode, and the
fallback for any slide with no probe of its own.

**A slide can name its own photo.** The properties panel's *Change this slide's
photo* carries the selected slide's index (`data-slide`, not `data-slice` — every
`[data-slice]` element is a host the deck painters draw layer nodes into) and
sets that one slide's `source`; the controls bar's *Use one photo for all slides*
carries none and sets every slide's, keeping each slide's framing. Both go
through one `MediaPickerDialog`, the scope riding on the per-call handler
`open(onConfirmOverride)` takes. The framing survives either swap because a
`crop` is fractions of its own source, and `specHash` includes `source`, so a
swap re-encodes exactly the slide it touched.

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

## Layers

S2 gave every slide a frame. S3 gives it marks that are
not photographic: `slides[].layers`, an ordered list of drawables in that
slide's own canvas space, and `doc.spanLayers`, one list in the **deck's**
canvas space — `n` slides wide by one slide tall — sliced across slide
boundaries so a headline or a rule runs *through* the seam. Both fields were
reserved in the schema from C5 and read by nothing until now.

**Layers are painted in both modes.** Unlike `crop` / `fit` / `bg`, which are
inert in `split`, a slide's layers reach the canvas whichever mode the document
is in: `renderCarousel` folds `slides.map(s => s.layers)` and `doc.spanLayers`
into the flat `SplitSpec` alongside the doc-level framing. A split deck carrying
a headline across its seam is the headline use case, and it is why the span-layer
box is normalized to the deck rather than to a slide count — a re-slice to a
different `n` re-flows the same headline across the new seams instead of dropping
it (`splitDocument` carries `spanLayers` through unchanged). The *studio* only
offers the layer panel in deck mode; see "What the studio does not yet offer".

### The layer schema

Five types over one shared `box`, produced by exactly one function —
`normalizeLayer` (`document.js`) dispatching a table of per-type builders
(`LAYER_BUILDERS`). `LAYER_TYPES` is derived from that same table, so the list of
what is valid and the code that produces it cannot disagree, and a sixth type is
one entry rather than a longer function.

Every layer carries `box`: `{x, y, w, h}` normalized 0..1 of the canvas it sits
on, never pixels. `w`/`h` are pinned to at least `MIN_BOX` = `1/1080` — one pixel
of the 1080px width every aspect shares, the only dimension they have in common —
and the origin is then clamped so `x + w <= 1` and `y + h <= 1` (`normalizeBox`).
That is the same discipline `clampPan` keeps for a crop against its source, done
arithmetically here: a box has no source to measure against, which is what keeps
`document.js` independent of `geometry.js`. Because the box is normalized, an
`aspect` change moves a layer with the frame instead of throwing it off.

`text` and `counter` share one typography block (`normalizeTextStyle`, so the two
cannot drift into subtly different typesetters):

| Field | Range | Default |
|---|---|---|
| `align` | `left` \| `center` \| `right` | `left` |
| `valign` | `top` \| `middle` \| `bottom` | `top` |
| `color` | hex (3/4/6/8 digits) or `transparent` | `#ffffff` — a mark over a photograph, and dark photographs are the common case |
| `weight` | 1..1000, rounded | `400`. The CSS `font-weight` range, not a static family's 100..900: the theme font may be variable and the canvas takes whatever CSS takes |
| `size` | fraction of the canvas **height**, or `null` | `null` = auto-fit the box. A headline that fits is worth more than one that is exactly 7% tall |
| `shadow` | boolean | `false`. One opinionated preset (`TEXT_SHADOW` in `render.js`), both numbers multiples of the font size so it survives a resize |

Neither carries an `opacity`: the alpha channel of a `#rrggbbaa` `color` is it.
The other three types do carry one (0..1, default `1`), because their fill or
their bitmap has nowhere else to put it.

| Type | Fields beyond `box` | Defaults and ranges |
|---|---|---|
| `text` | `text`, `lineHeight`, + the typography block | `text: ""`; `lineHeight` 0.5..4, default `1.2` — below 0.5 lines overprint, above 4 the box holds one line anyway |
| `image` | `source`, `fit`, `opacity` | `source: ""` (the studio seeds a new one from the `logo_url` setting when there is one); `fit` `cover` \| `contain`, default **`contain`** — unlike a slide's `cover`, because an image layer is a logo or a mark and cropping one to fill its box is never what was meant |
| `rect` | `fill`, `radius`, `opacity` | `fill: "#000000"` — a rect with no usable fill is a scrim, and a scrim darkens; `radius` 0..0.5 as a fraction of the box's **shorter side**, default `0`, so `0.5` is a pill and the corner survives a resize where canvas px would not |
| `counter` | `format`, + the typography block | `format: "{i}/{n}"` — `{i}` is the 1-based slide number, `{n}` the deck's length, everything else literal. A non-string is the only rejection: a format with neither placeholder is a caption, and that is allowed |
| `arrow` | `direction`, `color`, `opacity` | `direction` `left` \| `right`, default `right` — an arrow layer is the swipe-onward hint |

**Normalization drops an unrecognized layer rather than migrating it.** This is
the one place in this schema that can lose user data, and it is deliberate: a
layer's fields mean nothing without its `type`,
so a `type` outside `LAYER_TYPES` cannot be migrated into anything and
`normalizeLayer` returns `null`, which `normalizeLayers` filters out. Every
*other* field degrades instead — out of range is clamped, unrecognized is
defaulted, unknown is dropped — exactly as everywhere else in `document.js`. If a
hand-edited document comes back from a save one layer short, this is why.

`DOC_VERSION` stayed **1** through S3. `layers` and `spanLayers` have been
reserved-but-unvalidated since version 1, passing through `normalizeDocument` as
a bare `.slice()`, and no released code ever wrote a layer — so replacing the
passthrough with real normalization cannot invalidate a document in the wild. A
version bump would claim a migration exists; there is none.

Layer mutation goes through four writers, `addLayer` / `updateLayer` /
`removeLayer` / `reorderLayer` (`document.js`), which take a slide index or
`SPAN_SLIDE` (`-1`, negative by construction so no slide can collide with it) and
so serve a slide's own list and the deck's from one family of calls. They keep
`updateSlideFraming`'s contract exactly: `box` merges field by field (a drag
sends `{box:{x, y}}` without resetting the size), a patch value the schema
rejects leaves the layer's own rather than resetting it to the default, a
patched `type` is ignored, and an out-of-range index returns an equal document
instead of throwing — these run from pointer handlers, where a throw strands the
gesture. A reorder is a splice, not a swap: the list *is* the paint order.

### The Canvas/CSS geometry pair, again

The pair discipline S2 established for framing continues for layers. One private
helper, `layerFrame` (`geometry.js`), resolves a normalized box into a
whole-pixel rect; three exports read it:

| Function | Returns | Consumed by |
|---|---|---|
| `layerRect(layer, aspect)` | `{x, y, w, h}` in the slide's canvas pixels | `render.js` → the layer painters |
| `layerCSS(layer, aspect)` | the same region in **percent of the frame** | `studio/preview.js` → `left`/`top`/`width`/`height` |
| `spanLayerRect(layer, i, n, aspect)` | slide `i`'s slice of a deck-space box, in that slide's canvas pixels, or `null` | both — `render.js` paints it, `preview.js` positions it |

Only `box` is read, so a bare `{box}` is a valid argument and `geometry.js` stays
free of the layer schema — `document.js` imports `geometry.js`, never the other
way round. Edges are rounded, not sizes: `w` is `round(x1) − round(x0)`, exactly
how `sliceRects` derives its column widths, because rounding a width
independently lets two boxes sharing an edge round apart and leave a hairline.
`layerCSS` is derived from the pixel rect rather than from the box, which is what
makes a one-canvas-pixel nudge move one canvas pixel in the preview too.

### Spanning layers

A `doc.spanLayers` box is normalized to the deck box — `n · slideW` by `slideH` —
and **sliced, not duplicated**. `spanLayerRect` resolves the deck rect once
through `layerFrame`, then offsets it into slide `i`'s coordinates; because the
slide columns are exact multiples of `slideW`, the seam is continuous by
construction rather than by two roundings happening to agree.

The result is deliberately **slide-local and unclipped**: a layer crossing a seam
yields a **negative `x`** on the right-hand slide, and that is the point. The
canvas clips the overflow for free, and clipping here would re-wrap text that
starts off-slide and break the continuation. On the preview side the same
negative rect overflows a host with `overflow: hidden`, so the DOM clips exactly
where the JPEG's frame edge will. A layer that reaches a slide not at all gets
`null` and is skipped.

`spanLayerCoverage(layer, n, aspect)` is the studio's read of the same numbers:
the indices a span layer actually reaches, used to label a row ("slides 2–3") and
to flag one that reaches nothing as off-canvas rather than silently dropping it.
Contiguous by construction — a box is one rectangle.

`specHash` hashes **one slide** and so cannot see the deck's span layers, which
paint across that slide whether it knows about them or not. The caller folds
them in the same way it already folds `strategy` / `anchorY` — `slideSpecHash`
(`index.js`) passes `{strategy, anchorY, spanLayers}` as the `deck` argument — so
editing a span layer invalidates every slide's cached render, which is correct.

### Painting

Layer painting lives in `paintSlide` (`render.js`), **after the image blit**: a
layer is baked into the JPEG, never composited afterwards. Both sequencers get
layers for free through `encodeSlide`, the same reason `paintSlide` stayed the
shared core in S2 — a split slide and a deck slide are still produced by
literally the same calls in the same order.

The order within a slide is: background fill (where the slide's pixels do not
reach) → the image → `paintLayers` over the slide's own list, back to front, list
order preserved and never sorted, so a `rect` scrim under a headline is exactly a
rect earlier in the list → `paintSpanLayers` over the deck's, last, because a
span headline or logo lockup is the deck's top-level chrome. A slide with no
layers leaves `paintSlide` byte-for-byte where it was before layers existed:
`paintLayers` returns on an empty list without touching the context, so the S1/S2
render paths encode exactly the bytes they always did.

`LAYER_PAINTERS` (`render.js`) is the draw-layer twin of `LAYER_BUILDERS` — a
table, not a switch, so a type the schema knows and this build cannot draw is a
missing key, skipped whole, rather than a half-executed branch. Every painter
takes the same four arguments (context, layer, resolved pixel box, per-slide
env), which is what lets `paintSpanLayers` hand a painter a pre-sliced box
directly instead of resolving one itself.

Type by type:

- **`text`** is measured with a real 2D context, never a guessed metric.
  `wrapText` and `autoFitText` (`geometry.js`) have taken a `measure` callback
  and been unit-tested since #450 with no production caller; S3 is what wires
  them, to `ctx.measureText` bound to the size being tried. A numeric `size` is a
  fraction of the canvas height and wraps; `size: null` auto-fits, bounded before
  the scan starts by the box on both axes and floored at `MIN_AUTO_PX` = 8px
  (below that, clipping is the more honest failure). Everything the context
  remembers — font, fill, alignment, shadow — is set inside one `save`/`restore`,
  the measuring passes included, so no layer can leak state into the next.
- **`counter`** takes that same path with `{i}`/`{n}` substituted for the copy,
  through the same painter rather than a second typesetter.
- **`image`** is a single blit at whole-pixel coordinates. `loadLayerImages`
  decodes each one already cropped and resized to exactly the place it will
  occupy, the same 1:1 discipline the slide's own bitmap follows, so a 24MP file
  dropped in as a logo costs its box rather than its megapixels. Bytes come from
  the render's shared per-path `sourceLoader`, so a logo on all ten slides is one
  fetch and one probe; the decode is per layer and every bitmap is closed with
  the slide's, which is what keeps the constant-memory promise intact. Nothing
  there throws: a source that will not fetch, a decode that fails or a box with
  no area drops its own layer out of the map and `paintImageLayer` skips what it
  cannot find. One broken logo must never cost a whole carousel.
- **`rect`** fills, with `radius` converted from its fraction to canvas pixels
  here. Below half a pixel, or on a context too old to have `roundRect`, the
  corner is square — a square scrim beats a thrown render.
- **`arrow`** is a **stroked path, not a glyph**: the theme font stack is
  whatever the theme says it is and nothing guarantees it carries an arrow, so a
  `text` layer holding "→" is one missing face away from a tofu box baked into a
  JPEG. The box is the chevron's bounding box, inset by half the stroke
  (`ARROW_STROKE`, a fraction of the shorter side) so the round cap stays inside
  it; a box too small to hold its own stroke is skipped rather than drawn as a
  blot.

### Fonts

Type is set in **the active theme's font stack, resolved at paint time. There is
no bundled WOFF2** and there will not be — see [vendors.md](../vendors.md) for
the dependency policy that says so. `loadThemeCss()` runs unconditionally in
`app.js`, so the admin document already carries the token:
`browserDeps.resolveFont` reads
`getComputedStyle(document.documentElement).getPropertyValue('--font-family')`
and falls back to `DEFAULT_FONT_STACK` (the token's own value from
`frontend/css/common/tokens.css`) when it resolves to nothing.

It **awaits `document.fonts.ready` first.** `measureText` on a canvas whose face
has not loaded silently measures — and paints — a system fallback, so the JPEG
would disagree with the CSS preview beside it. That only happens on a cold load,
which is exactly the kind that ships.

The wait is lazy and paid once. `fontResolver` (`render.js`) memoizes the promise
for the whole render, so slide 9 pays nothing for what slide 1 waited for, and it
resolves nothing at all unless a slide actually carries a `text` or `counter`
layer (`TYPESET_LAYERS`) — a deck of rects and arrows, or of no layers, must not
wait on a font, and must issue exactly the calls it issued before layers existed.
A dep with no `resolveFont`, one that returns nothing usable, and one that throws
all land on `DEFAULT_FONT_STACK`: type in the wrong face beats a failed encode.

### The studio surface

The layer UI sits under deck mode's framing controls (`layerPanel` / `layerForm`
in `studio/panels.js`; `index.js` owns the state):

- **Two lists, one form.** The selected slide's own layers, and the deck's span
  layers ("Deck layers — across all slides"), each with the same five add chips
  (Text / Logo / Rectangle / Counter / Arrow — "Logo" is the `image` type, named
  for what it is nearly always used for).
  Both are shown **top of stack first** — users think in stacking order and the
  arrays are back to front, so the *view* is reversed, never the document, and
  "move up" raises a layer toward the front (a later array index). Every button
  is a delegated action carrying `data-scope` (`"slide"` or `"span"`), which
  `_layerTarget` turns into a slide index or `SPAN_SLIDE`. Span layers reuse the
  same five types and the same property form — a second family of editors for one
  schema is the failure mode.
- **The studio never authors a layer literal.** An add goes through `addLayer`
  with only a `box` (and an `image` layer's default `source`) set; every other
  field is `normalizeLayer`'s to fill. `_defaultLayer` lands that box inside the
  slide's `safeAreaRect` per type — a headline mid-frame, a counter near the
  bottom, a logo top-left, an arrow at the right edge — rather than at the
  origin, because a layer outside the frame's honest bounds is one the user has
  to move before it is any use. A span layer keeps the type's vertical placement
  and stretches across the deck.
- **Direct manipulation.** `createDeckGestures` (`studio/gestures.js`) drives
  the layer `box` with the identical provisional-write-then-commit cycle it
  already drove `crop` with: `hitLayer` geometrically hit-tests the selected
  layer and its eight resize handles (`HANDLE_GRAB_PX` of the edge, converted to
  box fractions through the pressed element's own size), `dragBox` produces the
  move or resize, `snapBox` clicks live edges onto the canvas edges, the centre
  lines and the safe-area rect within `SNAP_PX` (suppressed while Alt or Cmd is
  held) and reports which guides engaged so the chrome can draw them, and the
  whole thing lands in the document once, through `updateLayer`. A press that
  misses the selected layer falls through to the crop gesture, so pan/zoom is
  unchanged wherever a layer is not in the way. With a layer selected, a plain
  arrow key nudges its box and shift-arrow resizes it from its far edge, both at
  the same `KEY_PAN` scale the crop nudge uses; focus is restored to the element
  afterwards, because the nudge rebuilds it under the user's fingers. S3 attached
  all of this to the filmstrip's 128px thumbnail and S6 moved it to the stage,
  where a span layer became grabbable too — see "The stage is the editor".
- **The preview is CSS, as ever.** `paintDeckLayers` and `paintSpanLayers`
  (`studio/preview.js`) are the DOM twins of the two canvas functions, resolving
  every box through `layerRect` / `spanLayerRect` — the very rects the painters
  are handed — so the preview cannot round differently from the render.
  `paintLayerChrome` positions the selection outline, its eight handles and the
  snap guides; `paintSpanChrome` (S6) does the same for a span layer, sliced per
  column from `spanLayerRect`, and the two share one writer.

**The preview runs the render's own typesetter.** CSS has no `measureText`, so
left to itself the browser would break lines where it likes and the JPEG would
break them where `wrapText` does. Instead `preview.js` holds one memoized
offscreen 2D context, reads the same `--font-family` token `browserDeps`
resolves and awaits `document.fonts.ready` once (`ensurePreviewFont`, which the
studio calls from `afterRender` and repaints on), then calls `autoFitText` or
`wrapText` with `measure` bound to that context. There is exactly one
typesetter; the preview is a second caller of it, not a second copy — which is
what makes this *not* the "second typesetter in the preview" that was declined
in S3.

What comes back is emitted verbatim: the resolved lines at the resolved size,
`white-space: pre` so nothing can re-wrap them, in a block whose `line-height`
is the painter's own `fontSize · lineHeight` and whose top is `VALIGN_SLACK`'s
offset rather than a flexbox alignment. Both media then put the baseline at
`lineBox/2 + k` from the top of the line and differ only in `k`: a CSS line box
uses half-leading, so `k = (ascent − descent)/2`, while canvas `textBaseline:
'middle'` uses the font's *central* baseline. Those are **not** the same number
— measured in Chromium the gap is about 0.06 em, four canvas pixels at 60px
type — so `baselineShift` reads both off `TextMetrics` (`alphabeticBaseline`
under `textBaseline: 'middle'`, against `fontBoundingBox*`) and offsets the
block by the difference rather than assuming it away. Rasterized side by side
through a `foreignObject`, the two then land on the same rows to the pixel at
24–60px and within one row at 91px.

The layer element does **not** clip, either: a fixed size too big for its box
spills out of it on the canvas, and the frame — which does clip — is where the
JPEG's own edge is.

An `arrow` is an inline SVG `<polyline>` over a `viewBox` that *is* the layer's canvas-pixel box:
the same three points, the same `stroke-linecap: round`, the same
`max(1, round(min(w, h) · ARROW_STROKE))` width, and the same refusal to draw a
box too small to hold its own stroke. The `❯` glyph is gone.

`preview.js` imports those numbers — `MIN_AUTO_PX`, `TEXT_SHADOW`,
`ARROW_STROKE`, `VALIGN_SLACK`, `ALIGN_ANCHOR`, `fontSpec`, `counterText` —
from `render.js` rather than restating them, and the dependency runs one way:
the preview reads the render, never the reverse. `carouselStudioPreview.test.js`
paints the same layer through both halves and asserts they agree line for line,
so the claim is falsifiable rather than aspirational. What remains different
between the stage and the JPEG is glyph **rasterization** — subpixel positioning
and hinting — and nothing else. The render is still the contract; `paintSlide`
is what produces bytes.

## The stage is the editor

S6 changed no stored field and no painter. It changed **where the pointer goes**:
the big deck-space stage, a read-only picture since C7, became the surface every
gesture acts on, and the filmstrip below it demoted to a rail whose only job is
the selection.

That inversion — rather than a new canvas element — was the right shape because
the canvas already existed. `.carousel-studio__stage` has been a single
deck-space strip from the start: `aspect-ratio: n·w/h`, a dashed seam divider at
every `(i+1)/n`, a safe-area box per slide, and in deck mode one
`.carousel-studio__stage-slide` per slide already carrying that slide's framing,
its layer nodes, the sliced span layers and the selection chrome. Two accidents
kept it inert:

- **A stale `max-width: 22rem`** from the C7 skeleton survived the cascade — the
  real rule set `width: 100%` and never re-declared the cap — so an eight-slide
  4:5 deck rendered 352×55px. The page's own opt-out of the admin content clamp
  (`contentClass: "carousel-studio-full-width"`) bought nothing.
- **The gestures attached to the wrong element.** `createDeckGestures` bound
  `.carousel-studio__frame--deck`, the filmstrip thumbnail at `flex: 0 0 8rem`,
  so every pan, zoom, layer drag and resize happened inside 128px while the
  deck-space view above it could not be touched. That is also why the page read
  as three copies of the same carousel: a stage you could not edit, a filmstrip
  you edited in, and the rendered strip.

A second surface would have had to grow its own seams, safe areas and per-slide
hosts, which is a second consumer of the same geometry beside `preview.js` — the
drift the Canvas/CSS pair exists to prevent. Moving the gestures up cost the
columns a `tabindex`, a `role` and an aria label, the `cursor: grab`, the
`touch-action` and the `is-dragging` / `is-selected` / `:focus-visible` dressing,
and nothing else: same crop gesture, same snapping, same commits, same clamps.

### Giving the stage room

Width alone would not have been the fix. At `n = 20` the stage is 16:1, and
fitting that to the container turns it straight back into a sliver. The stage
runs off a **height budget** instead — `clamp(12rem, 45vh, 32rem)`, and
`clamp(9rem, 38vh, 20rem)` on a phone — with `width: fit-content` letting the
inline `aspect-ratio` transfer that height into a width, inside a
`__stage-scroll` wrapper that absorbs the overflow so the page itself never
gains a horizontal scrollbar. Measured: 1080×450 at three slides on a 1376px
column, 6480×405 at twenty.

A zoom control under the stage (− / readout / + / Fit / 100%) multiplies the
budget through one custom property, `--carousel-stage-zoom`, written straight to
the builder root — so a zoom costs no rebuild, the same way the properties
toggle costs none. "100%" there means *the budget*, not 1:1 with the 1350px
canvas, which is taller than any laptop. *Fit* measures, because the budget is a
`clamp()` of `vh` and only layout knows what that is worth in pixels.

`carousel.css` had no `@media` rule at all before S6, and now honours both admin
breakpoints: 48em trims the stage budget and the rail's frames, and below 64em
the mode's own panel — the deck panel plus its layer lists, or the fit panel —
becomes a bottom sheet with a backdrop. That is copied from
`.editor-details-panel`, down to the state class on the layout root, the sibling
backdrop, `85dvh` and the translate: `components/shared/` has no sheet
primitive, and this was not the change to invent one in.

Two of those numbers cannot live in the stylesheet alone — the page has to
answer "sheet or rail?" *before* it renders, and the zoom control has to clamp
what it writes — so `studio/layout.js` mirrors the 64em breakpoint and the zoom
range into JS, for the reason `tagGestures.js` gives for its own
`SWIPE_BREAKPOINT`: a breakpoint written twice is a breakpoint that will
disagree with itself. The panel's open/closed choice is remembered
(`point:carousel:props-open`) on a wide viewport only — a sheet over the stage
always opens closed, exactly how `PostEditPage` treats the editor's Details
rail.

A deck frame was `touch-action: none`, so a thumb landing on one could not
scroll the page. It is `pan-y` now, and `gestures.js` no longer claims a touch
drag at pointerdown: it waits for the movement to declare an axis through
`gestureDirection` — the tags manager's helper, at the same 8px threshold — and
lets a vertical one go. A mouse, a pen and a second finger still claim the press
immediately; a pinch is never a scroll.

### The filmstrip is a rail

It keeps one job: moving the selection. Each item is a
`<button data-action="select-slide">` carrying a thumbnail, a slide number and
the pressed state. The layer nodes, span nodes and chrome it used to duplicate
are gone, so a selected layer's outline is drawn once — on the stage, where it
can be grabbed.

### Two coordinate spaces

With the gesture on the stage, the element under the pointer *is* the deck box,
and the two reasons S3 deferred span-layer direct manipulation ("the pointer
maths have to run in deck coordinates rather than one frame's, and the chrome
has to be sliced across every frame the layer crosses") both became cheap. The
fact that there are now two spaces lives in exactly one function.

`layerSpace(rect, safe, seams)` (`gestures.js`) names the three things a layer
gesture reads off geometry: the rect the box is fractions of, what `SNAP_PX` is
worth in it, and the lines to snap against. `onPointerDown` resolves it once
onto `drag.space` rather than re-deriving the tolerance and re-asking the host
for the safe area on every event — a refactor with no behaviour change of its
own, landed first precisely so the second space would not spread a branch
through the module. Span scope then differs in what it is *handed*, not in a
branch downstream:

- `deckRect(rect, i, count)` turns the pressed column's rect into the whole
  deck's. The columns are equal widths side by side, so it follows from any one
  of them exactly — no second measurement, and no dependence on the stage
  element. `hitLayer`, `dragBox` and the snap tolerance then all work in deck
  fractions without knowing that is what they are doing.
- A press on **any** column the layer reaches grabs it, since its box spans them
  all, and an arrow nudge works from whichever column holds focus.
- `snapBox` stopped deriving its own guides and takes them resolved
  (`snapLines`), which is one branch *fewer* in the plugin's worst function
  rather than one more. Deck space adds the seams (`deckSeams`) and swaps the
  slide safe area for the deck's — vertically the same band, horizontally slide
  0's left inset to slide n−1's right — so a headline snaps to the margins that
  actually cut it off rather than to a seam it is meant to cross.
- The commit is addressed to `SPAN_SLIDE`, so it keeps the span selection and
  leaves the slide selection where it was.

Selection chrome is sliced the way the preview element already is:
`paintSpanChrome` positions it from the same `spanLayerRect` the painters are
handed, so the outline and whichever of the eight handles falls inside a column
run continuously across a seam, and `overflow: hidden` does the clipping. Every
column carries a chrome node while a span layer is selected, and a column the
layer misses is hidden rather than emptied — which is what lets a drag carry it
over a seam and find chrome waiting, with no rebuild mid-gesture.

### The vertical anchor is dragged, not slid

`anchorY` had a horizontal slider for an up-and-down quantity. The split stage
paints the source as a CSS background, so the band itself can be dragged, over
the one field split mode has. `createAnchorGesture` joins `createDeckGestures`
in `gestures.js` as a separate small controller rather than a branch: the two
surfaces never coexist, and the split stage has no crop, zoom or layers to route
a press between. What the two share is the provisional-paint-then-commit cycle
and the direction-declaring touch claim, mirrored to the other axis — the stage
is `touch-action: pan-x` while there is slack, so a sideways finger still pans
the strip.

An actual vertical rail is drawn down the stage's left edge, filled to where the
band sits and carrying the percentage; a drag repaints the rail, the filmstrip
and the slider together, through one custom-property write and the background
positions the band already lives on. The slider stays as the keyboard and
assistive path, and says where the direct one is. The visibility condition is
unchanged (`fitReport`'s `trimmedH > 1`): with no slack there is nothing to
drag, the rail is not emitted at all, and the stage keeps its default scroll
behaviour.

### Adding, removing, duplicating and reordering slides

Until S6 the slide count could only be set in `split` mode, where all three
controls re-derive the whole array from one strip through `splitDocument`. In
`deck` mode it could not be changed at all — the only route was back through
split, which discards every per-slide crop. So there was no way to add one slide
and no way to drop one.

`document.js` gains the four writers the layer family already has —
`addSlide(doc, at, slide)`, `removeSlide(doc, i)`, `duplicateSlide(doc, i)` and
`moveSlide(doc, from, to)` — keeping that family's contract exactly: an index
that names nothing returns an equal document, nothing throws (these run from
pointer handlers, where a throw strands a gesture), and a move is a splice
rather than a swap, for the same reason `reorderLayer` is one — the array *is*
the order the carousel is read in. They carry **no slide-count bounds**:
`MIN_SLIDES` / `MAX_SLIDES` belong to the state owner, which can refuse in a
toast, and a model that refused silently would leave its caller unable to tell a
refusal from a no-op.

**A new slide is never rendered**, whatever it was handed — `addSlide` clears
`rendered`, and `duplicateSlide` is `addSlide` of its own twin. `rendered` names
a media row, and two slides claiming one row is the state `_deleteSuperseded`
cannot reason about: deleting one of the pair would take the other's image with
it. A duplicate is also pixel-for-pixel its twin until something moves, and two
byte-identical slides are what `assertDistinctMedia` refuses at render time — so
a duplicate is a starting point, and the studio says so.

**A removed slide's media row is collected by the *next* render**, not at
removal. The row carries a `post_id`, so `ListOrphanedMedia` will never flag it,
and nothing but the supersede cleanup can ever collect it — which it does,
because that cleanup reads the *saved* generation (`_priorRendered`) rather than
the working document. Deleting the row at removal would put the file beyond the
reach of the Ctrl+Z otherwise sitting right there.

**Span layers needed no work.** Their boxes are fractions of the whole n-wide
deck, so a changed slide count re-flows them across the new seams rather than
dropping them — the same behaviour `splitDocument` already relies on when it
re-slices a source to a different `n`.

On the surface, the rail grows a drag handle per slide and one row of add /
duplicate / delete under it, acting on the selection rather than three chips on
every frame. Split mode gets none of it: the count is derived from the fit panel
there, and a control that added a column would be offering to break the
derivation. Reorder goes through `attachPointerReorder`
(`frontend/src/utils/pointerReorder.js`) rather than HTML5 drag-and-drop, which
does not exist on iOS; the util grew an `axis` option for it, so a horizontal
rail turns the midpoint test, the drop line and the edge scroll 90° and scrolls
itself rather than the page (and the edge scroll now sits out entirely when the
container has nothing to scroll, instead of spinning for the length of every
drag over a strip that already fits). The handle is a control of its own,
separate from the frame, because the util claims the pointer on press — a handle
that *was* the frame would eat the click that selects the slide. Arrow keys on
the handle do the same move, claiming focus before the write, since `_setDoc`
renders synchronously.

### Undo and redo

The studio had no way back: a wheel tick over a slide changed its zoom for good,
and two confirms said "this cannot be undone" and meant it. Undo turned out to
be nearly free, because the document is already immutable by construction —
every writer in `document.js` returns a *new* `CarouselDoc`, and the page
commits with `setState({ doc })` under the document-is-the-state contract. So
history is **a ring of document references** (`studio/history.js`): no cloning,
no inverse operations, no command objects, and undo is "hand back the previous
reference". The ring holds 60, which is deep enough for a working session and
trivial next to the media the documents point at.

Granularity is free for the same kind of reason: the studio already commits at
the right moments. `gestures.js` paints provisionally and commits once per
gesture (a wheel burst debounces into a single commit through
`WHEEL_COMMIT_MS`), and the property forms repaint on `input` and commit on
`change`. Pushing at those commit points — and nowhere else — reproduces the
step size a user expects, with no debouncing of its own.

- **`_setDoc(doc, patch, { history })` is the one writer.** Every mutator routes
  through it — the split controls, the mode switch, slide framing, the four
  slide writers, the four layer writers, the aspect select and the source picker
  — and it is the only place a document reaches `setState`.
- **`push` dedups**, by reference first and then by `serializeDocument`, because
  several writers deliberately return an *equal* document when the value they
  were given is rejected (a pan that ran into the edge of the source, a fit chip
  clicked twice). The reference check is the cheap half and the common case; the
  normalize-and-stringify is only reached when the references differ.
- **A render is not a step.** It stamps `rendered` blocks onto the document
  already on screen, so it `replace`s the current entry rather than adding one —
  otherwise undoing the *next* edit would land on a document that has to
  re-encode every slide.
- **A step drops the layer selection and re-probes sources.** A layer index
  points into a list the other document may not have, and a stale one edits the
  wrong layer; the slide selection survives, because `_selectedIndex` already
  pins it inside whatever deck arrives. Source pixel dimensions are derived data
  the ring deliberately does not carry, so `_probeSources` runs after a step —
  cached per path, so stepping back and forth across a source swap costs one
  probe, not one per step.
- **Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z**, bound on `document` (a page-level
  shortcut has to work when nothing inside the studio holds focus) and bailing
  inside an input or textarea, so native text undo still wins in a layer's text
  field. Header buttons too, since a phone has no Ctrl. Both combinations are
  registered in `ShortcutHelp`.

Two confirm dialogs became toasts carrying an **Undo** button — `Toast` gained
an optional `action`, spent on first press — because a confirm in front of a
reversible step asks the user to decide before they can see what it does, while
a toast tells them after and carries the way back. The deck→split switch and a
deleted layer are both of those. The remove-carousel confirm stays: it deletes
media rows server-side, outside the document, where undo cannot reach.

## What the studio does not yet offer

The background control is shown only for a slide that actually has a letterbox
to fill — offering a fill that paints nothing is worse than offering none — and
the gradient control edits two ends only, so a hand-authored document with three
or more stops loses the middle ones the moment that panel writes.

One gap is S3's own:

- **Layers are authored in deck mode only.** The renderer paints
  `slides[].layers` and `doc.spanLayers` in **both** modes, and a split document
  carrying layers renders them correctly — but `builder` (`studio/panels.js`)
  emits the layer panel and the stage's per-slide layer hosts only when
  `mode === "deck"`, so in split mode there is no way to add one from the UI. A
  split deck that wants a headline is one switch to Slides away, which is why
  this was accepted rather than fixed alongside the panel.

S3's other gap — a span layer being form-only, drivable through the property
form but not by pointer — closed in S6 when the gesture moved to the stage; see
"Two coordinate spaces". So did the per-slide source picker S2 left open, and
the three preview divergences S3 accepted for text and arrows.

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
| Layer placement | A normalized `{x, y, w, h}` box in 0..1 of the canvas, never pixels | `aspect` is a document-level switch, so a 4:5 → 1:1 change has to move a layer *with* the frame rather than throw it off. Same discipline `crop` follows against its source, and it keeps `document.js`'s clamp arithmetic — no source to measure against, so no dependency on `geometry.js` |
| Where layer geometry lives | `geometry.js`, as a Canvas/CSS pair (`layerRect` + `layerCSS`) plus `spanLayerRect`, all three over one private rounding helper (`layerFrame`) | Exactly the relationship `deckSlideRects`/`deckSlideFitCSS` already have, for the same reason: the studio's preview is DOM and the export is canvas, and two formulas rounding independently is how a filmstrip starts lying about the render. One rounding site is the only way to guarantee they agree |
| Text measurement | A real 2D context's `measureText`, bound to the size being tried — never a metric guessed from character count | `wrapText`/`autoFitText` took a `measure` callback and were fully unit-tested from #450 with no production caller; S3 wires them to the slide canvas on the render path. A guessed metric makes auto-fit wrong in exactly the fonts a theme is most likely to set |
| Fonts | The active theme's `--font-family`, resolved at paint time, with `document.fonts.ready` awaited before the first paint. **No bundled WOFF2** | `loadThemeCss()` runs unconditionally (`app.js`), so the admin document already carries the token; a slide should be set in the blog's own type, not in a face the studio shipped. Bundling one would add a binary asset to a repo whose vendoring policy is "short, vendored, unminified and reviewable" ([vendors.md](../vendors.md)). Awaiting the face matters because `measureText` on an unloaded font silently measures a system fallback, so the JPEG would disagree with the preview beside it |
| Waiting on the font | Lazily, once per render, and only when a slide carries a `text` or `counter` layer | A deck of rects and arrows, or of no layers at all, must issue exactly the calls it issued before layers existed — that is what keeps the S1/S2 render paths provably unchanged. `fontResolver` memoizes the promise, so slide 9 pays nothing for slide 1's wait |
| Where layers are painted | Inside `paintSlide`, after the image blit — baked into the JPEG, never composited later | Both sequencers then get layers for free through `encodeSlide`, the same reason `paintSlide` stayed the shared deterministic core in S2. A split slide and a deck slide are still produced by literally the same calls in the same order |
| Layers in `split` mode | Painted, unlike `crop`/`fit`/`bg`, which are inert there | A split deck with a headline running across its seam is the headline use case — the composition twin of what `split` already does to a photograph. `renderCarousel` folds the per-slide lists and `doc.spanLayers` into the `SplitSpec` |
| `spanLayers` | Sliced per slide from one deck-space rect, not duplicated per slide | A duplicated layer would have to be kept in sync by the editor and would break at the seam; a slice is continuous by construction, because the columns are exact multiples of `slideW`. The slice is deliberately unclipped — a negative `x` on the right-hand slide is what lets the canvas clip for free without re-wrapping text that starts off-frame |
| `spanLayers` in `specHash` | Folded in by the caller, alongside `strategy`/`anchorY` | `specHash` sees one slide and cannot find the deck's span layers, which paint across that slide whether it knows about them or not. Without the fold, editing a headline would leave every slide's cached render in place |
| An unrecognized layer | **Dropped** by `normalizeLayer`, not migrated — and `DOC_VERSION` stays `1` | A layer's fields mean nothing without its `type`, so there is nothing to migrate it into. The tightening is safe because `layers`/`spanLayers` were reserved-but-unvalidated since version 1 and no released code ever wrote one; bumping the version would claim a migration that does not exist. This is the one place S3 can lose user data, which is why it is stated in "Layers" as well as here |
| Layer type dispatch | A table in `document.js` (`LAYER_BUILDERS`) and its twin in `render.js` (`LAYER_PAINTERS`), keyed by `type` | `LAYER_TYPES` is derived from the builders, so the list of what is valid and the code that produces it cannot disagree. On the draw side a type the schema knows and the build cannot paint is a missing key — skipped whole — rather than a half-executed branch, so a future sixth type degrades instead of corrupting a slide |
| A broken `image` layer | Skipped; the rest of the slide still renders | A source that will not fetch, a decode that fails or a box with no area drops that one layer out of the map `paintImageLayer` reads. One broken logo must never cost a whole carousel — the same reason a bad gradient degrades in `normalizeBg` rather than throwing mid-encode |
| `arrow` as a shape | A stroked canvas path, not a glyph | The theme font stack is whatever the theme says it is, and nothing guarantees it carries an arrow: a `text` layer holding "→" is one missing face away from a tofu box baked into a JPEG |
| Layer preview fidelity | The preview measures on its own offscreen 2D context and runs the render's `wrapText` / `autoFitText`, then emits the resolved lines `white-space: pre` at the painter's own line box; `arrow` is an inline SVG polyline over the same `layerRect` numbers. Only glyph rasterization still differs | The earlier position — fixed 9% auto-fit, browser line breaking, a `❯` glyph — was accepted because chasing parity looked like a second typesetter, "the drift the Canvas/CSS pair exists to prevent". Binding `measure` to a real context is the opposite of that: `wrapText`/`autoFitText` take a `measure` callback precisely so there can be one typesetter with two callers, and the constants come from `render.js` by import rather than by copy. The render is still the contract |
| The studio's editing surface | The deck-space stage, with the filmstrip demoted to a selection rail | The stage was *already* the deck-space canvas — `aspect-ratio: n·w/h`, seam dividers, per-slide safe areas, and in deck mode one host per slide carrying its framing, layers and chrome. It was only capped (a stale `max-width: 22rem` from the C7 skeleton) and inert (`createDeckGestures` bound the filmstrip's 128px thumbnail). Inverting those two lands the asked-for model as a *rearrangement* of what exists; a new canvas element would have grown its own seams, safe areas and per-slide hosts — a second geometry consumer beside `preview.js`, which is exactly the drift the Canvas/CSS pair exists to prevent. It also dissolved the deferral on span-layer manipulation, because on the stage the element **is** the deck box |
| Undo / redo | A ring of `CarouselDoc` references (`studio/history.js`), pushed at the commit points the studio already had | The document is immutable by construction — every `document.js` writer returns a new one and the page commits with `setState({ doc })` — so a snapshot ring needs no cloning, no inverse operations and no command objects. Granularity comes free too: `gestures.js` already debounces a wheel burst into one commit and the property forms already repaint on `input` and commit on `change`, so pushing there *is* the step size a user expects. A render `replace`s the current entry instead of adding one, since stamping `rendered` blocks is not an edit but the entry has to carry them or the next undo re-encodes every slide |
| Mode naming | **Panorama** / **Slides** on the chips; `split` / `deck` in the code, in this document and on disk | The stored values are the schema and changing them would mean a migration for a wording choice. The chips name what the user is choosing — one wide photo cut across every slide, versus a photo per slide — and the naming lives in `modeToggle` (`studio/panels.js`) and nowhere else, so there is one vocabulary in the code and one on screen, with a single translation point between them |
| Per-slide sources in the picker | One `MediaPickerDialog`; the scope rides on the button — the properties panel's *Change this slide's photo* carries `data-slide`, the controls bar's *Use one photo for all slides* carries none | The renderer and schema have supported a multi-source deck since S2 (`renderDeck` dedups per path). What was missing was only the intent, and a per-call handler (`open(onConfirmOverride)`) already existed to carry it — a second dialog, or a mode flag on the studio, would be two code paths for one question. `specHash` includes `source`, so a swap re-encodes exactly the slide it touched, and framing survives either swap because a `crop` is fractions of its own source |
| A removed slide's media row | Left for the *next* render's supersede cleanup, not deleted at removal | The row carries a `post_id`, so `ListOrphanedMedia` never flags it and only the supersede cleanup can collect it — and that cleanup reads the *saved* generation, so it collects the row on the next render without any new code. Deleting at removal would put the file beyond the reach of the Ctrl+Z that is otherwise sitting right there, for a row that costs nothing to keep until then |
| Slide-count bounds | Enforced by the state owner (a disabled chip, a toast), not by the four slide writers | The writers keep the layer family's contract — an index that names nothing returns an equal document and nothing throws, because they run from pointer handlers. A silent refusal inside the model would leave the caller unable to tell a refusal from a no-op, which is the one thing a document writer must never do |

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
    "layers": [                                          // both modes; back to front
      { "type": "text", "box": { "x": 0.05, "y": 0.62, "w": 0.9, "h": 0.22 },
        "text": "Headline", "lineHeight": 1.2, "align": "left", "valign": "top",
        "color": "#ffffff", "weight": 700, "size": null, "shadow": true }
      // + image | rect | counter | arrow — every type, field and default under "Layers"
    ],
    "rendered": { "path": "…", "media_id": 42, "specHash": "…" }
  }],
  "spanLayers": [ /* the same five shapes, box normalized to the deck:
                     n slides wide by one tall — see "Spanning layers" */ ],
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
`layers` and `spanLayers` are read in **both** modes — see "Layers".

Every field is normalized on the way in by `document.js` — unknown fields
dropped, out-of-range numbers clamped, an unusable gradient degraded to the
default rather than thrown — and `normalizeDocument` is idempotent, which is
what makes parse/serialize a round trip. `DOC_VERSION` is still `1` through S3:
everything S2 and S3 added was already reserved in the schema or is additive.
The one exception to "degrade, never drop" is a layer whose `type` is not one of
the five — `normalizeLayer` drops it, because a layer's fields mean nothing
without its type. That is the only way this schema loses user data; the "Layers"
section says so at length.

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
| **Bundling a WOFF2 with the plugin** so slide type is identical everywhere | Point ships no npm runtime dependency and vendors only what it must, unminified and reviewable ([vendors.md](../vendors.md)); a binary font asset is the opposite of that, and it would set a blog's carousel in a face the blog does not use. The active theme's `--font-family` is both the honest choice and the free one — `loadThemeCss()` has already put it on the document. |
| **A second mutator family and a second property form for `spanLayers`** | They are the same five types over the same `box`; only what `1` means (the deck, not a slide) differs, and that is the renderer's business. One `SPAN_SLIDE` index through the existing `addLayer`/`updateLayer`/`removeLayer`/`reorderLayer` and one `layerForm` keeps a slide layer and a span layer from drifting into two subtly different editors. |
| **Duplicating a span layer onto each slide it crosses** at edit time | The editor would then own keeping N copies in sync, and the copies would still break at the seam — each would re-wrap and re-fit inside its own frame. One deck-space rect sliced per slide is continuous by construction. |

## Delivery stages

C1–C9 are tracked as beads under the Carousel Studio epic. U1–U6 are a
sizing-and-studio-UX pass that landed after C9, ahead of S2 — `anchorY` (vertical crop
placement) landed there rather than in S2, so S2 narrowed to per-slide pan/zoom on
**both** axes plus cover/contain, background fill and `deck` mode. S6 is an
editing-surface pass that landed after S3, out of numeric order with S4–S5,
because five of its eight complaints collapsed into one rearrangement of the
stage. S2, S3 and S6 are done; S4–S5 remain, and C5/C6's schema held for all
three without a version bump, which is the evidence that they are extensions
rather than rewrites — S6 went further and added no stored field at all.

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
| **S3** | Layers — per-slide and canvas-space spanning layers, text with wrap/auto-fit, logo, counters. Uses the active theme's font stack, **not** bundled WOFF2 (`docs/vendors.md`). **Done** — see "Layers" above. `document.js` gains the five-type schema (`normalizeLayer` over `LAYER_BUILDERS`, `LAYER_TYPES`) and the `addLayer`/`updateLayer`/`removeLayer`/`reorderLayer` family addressing a slide or `SPAN_SLIDE`, with `spanLayers` folded into `specHash` by the caller; `geometry.js` gains the `layerRect`/`layerCSS` pair plus `spanLayerRect`/`spanLayerCoverage` over one `layerFrame` helper; `render.js` gains `paintLayers`/`paintSpanLayers` inside `paintSlide`, the `LAYER_PAINTERS` table, `loadLayerImages` and the lazy `fontResolver`; `index.js` was split into `studio/{bounds,panels,preview,gestures}.js` first (no behaviour change) and then grew the layer panel, the per-type property form and stage drag/resize/snap. Tests in `frontend/test/carousel{Document,Geometry,Render,StudioPage}.test.js` and `carouselStudio{Bounds,Panels,Preview,Gestures}.test.js`. **Two things it does not do:** layers are authored in deck mode only (the renderer paints them in both), and a span layer is form-only on the stage — direct manipulation for it is filed as a follow-up. Both are recorded under "What the studio does not yet offer". |
| **S4** | Predefined canvases as JSON in the repo: this same document schema with placeholder values, so a canvas is a document, not a new format. Placeholders reuse the caption-template vocabulary (`{title}`, `{excerpt}`, `{tags}`, `{link}`) — a *different* substitution from a `counter` layer's `{i}`/`{n}`, which S3 resolves at paint time from the slide's position and which no template file supplies. S4 reads `doc.template`, which S3 deliberately left untouched. |
| **S5** | Production — caption composer, one-click push, brand kit scoped to 2–3 settings rows. The brand kit widens something that already exists rather than introducing it: an `image` layer added in the studio already defaults to the site's `logo_url` setting (S3), and S3 added no settings row of its own (see "Out of scope"). |
| **S6** | The studio becomes one canvas: the stage is the editing surface, at a size worth editing on and with a bottom-sheet panel on a narrow viewport; undo/redo; slide add / remove / duplicate / reorder; Panorama/Slides chips and a per-slide source; the vertical anchor by direct drag; and preview/render parity for text and arrows. **Done** — see "The stage is the editor" above. Nothing stored changed: `document.js` gains only `addSlide`/`removeSlide`/`duplicateSlide`/`moveSlide`, `DOC_VERSION` stays 1, `geometry.js` is untouched, and `render.js`'s painting is unchanged (it only exports the constants `studio/preview.js` now imports instead of restating). New modules `studio/{history,layout}.js`; `gestures.js` gains `layerSpace`/`deckRect`/`snapLines`/`deckSeams` and `createAnchorGesture`; `preview.js` gains `ensurePreviewFont`, `textPlan`, `arrowPlan` and `paintSpanChrome`; outside the plugin, `utils/pointerReorder.js` gains an `axis` option and `Toast` an optional `action`. Tests in `frontend/test/carouselStudio{History,Layout,Gestures,Panels,Preview}.test.js`, `CarouselStudioPage.test.js`, `carouselDocument.test.js` and `toastAction.test.js`. |

## Out of scope

- Server-side slide rendering (see rejected alternatives).
- A custom-template editor (S5 note).
- Video / Reels slides — the Instagram publish path is image-only (`instagram-integration.md`).
- Changing the media library or `ListOrphanedMedia` to understand generated slides — the document tracks its own `media_id`s.
- A Plugins-page settings affordance for `carousel`: it appears in neither `PLUGIN_SETTINGS` nor `SETTINGS_PAGE_PATHS` (`frontend/src/pages/light/PluginsPage.js`), so today the plugin toggle has no settings drawer/link. S5's brand kit is what will need one.
- Bundled webfonts for slide type. Layers set in the active theme's `--font-family` (see "Fonts"); a self-hosted WOFF2 is a vendoring decision this repo has already made the other way ([vendors.md](../vendors.md)).
- Typographic controls beyond the schema's six fields — no letter-spacing, no per-run styling, no rich text. A layer is a mark, not a text editor.

## Prove it

```bash
(cd api && go test ./internal/services/ -run Render)
npm run test:frontend
```

The first pins the fence render contract; the second covers `geometry.js`,
`document.js`, `render.js` and the studio modules. `./scripts/check.sh` is the
full gate (lint, both test suites, and `check-docs.sh` over the commands this
repo documents) — it is not listed in the block above because running it from
inside `check-docs.sh` would recurse.
