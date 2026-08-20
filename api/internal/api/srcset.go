package api

import (
	stdhtml "html"
	"regexp"
	"strconv"
	"strings"

	"point-api/internal/models"
	"point-api/internal/services"
)

// Article images are the heaviest bytes on the site: until the ladder existed
// a post body loaded every photo at its full camera resolution, because
// PostContent never asked for a thumbnail and the server emitted a bare
// <img src>. injectArticleSrcset closes that by adding srcset + sizes to the
// rendered HTML.
//
// It runs on the OUTPUT of PostService.RenderContent — after bluemonday — for
// the same reason addImgLoadingHints does. srcset is deliberately absent from
// the sanitizer policy: post-sanitise injection is what stops an author
// writing their own srcset full of arbitrary URLs. Adding it to the policy
// would hand that back.
//
// `src` is left pointing at the bare original on purpose. PostContent.js and
// MediaViewer.js build the lightbox from extractMedia's `\ssrc="…"` capture
// (postMedia.js), so a variant in `src` would quietly turn "the lightbox opens
// the original" into "the lightbox opens a 512px JPEG". Keeping it bare also
// means no frontend parser has to change.

// articleImageSizes describes how wide a post-body image actually paints, so a
// browser can pick a candidate before layout exists.
//
// The prose column is --content-narrow (50rem; public/tokens.css via
// common/tokens.css --size-50), and .post-single caps to it. Below that width
// an image fills the viewport. From 112rem up, single-post.css switches to the
// ultrawide grid and breaks figures out of the column with
// `width: calc(100% + 400px)` — 50rem + 400px = 75rem. First match wins, so
// the narrow rule has to come before the ultrawide one.
const articleImageSizes = "(max-width: 50rem) 100vw, (min-width: 112rem) 75rem, 50rem"

// articleImgTagRe matches an <img …> tag and captures its attributes, the same
// shape (and the same tolerance for goldmark's self-closing form) as the
// loading-hint pass this runs beside.
var articleImgTagRe = regexp.MustCompile(`(?i)<img\b([^>]*?)\s*/?>`)

// articleImgSrcRe pulls the src attribute out of those captured attributes.
// The leading \s is load-bearing: without it this would also match the src in
// `srcset="…"` on a second pass.
var articleImgSrcRe = regexp.MustCompile(`(?i)\ssrc="([^"]*)"`)

// imageDims is a source image's intrinsic size, which is what makes the
// descriptors real pixel widths rather than guesses.
type imageDims struct {
	width  int
	height int
}

// articleImageDims indexes the media rows a post references by their public
// path ("/YYYY/MM/file.jpg"), keeping only images whose dimensions are
// recorded. A row without them cannot produce an honest descriptor, so it is
// left out and its <img> stays bare.
func articleImageDims(media []models.Medium) map[string]imageDims {
	if len(media) == 0 {
		return nil
	}
	dims := make(map[string]imageDims, len(media))
	for _, m := range media {
		if !strings.EqualFold(m.FileType, "image") {
			continue
		}
		if !m.Width.Valid || !m.Height.Valid || m.Width.Int64 <= 0 || m.Height.Int64 <= 0 {
			continue
		}
		dims["/"+strings.TrimPrefix(m.OriginalPath, "originals/")] = imageDims{
			width:  int(m.Width.Int64),
			height: int(m.Height.Int64),
		}
	}
	if len(dims) == 0 {
		return nil
	}
	return dims
}

// articleSrcset builds the candidate list for one image, or "" when there is
// nothing worth offering.
//
// A rung caps the LONGEST side, so the candidate's width is only the rung
// itself on a landscape or square source; a portrait at rung R is
// int(R * W/max(W,H)) wide. The expression mirrors imaging.Fit's own
// conversion (and mediaUrl.js's thumbSrcset) exactly, because a descriptor
// that over-states by even a pixel is a descriptor that is wrong.
//
// Rungs at or above the longest side are dropped: writeLadder never writes
// them and the route serves the original for them, so listing one would be a
// second URL for the same bytes and a second cache entry.
//
// The ORIGINAL always takes the top slot, at its real intrinsic width. The
// ladder stops at 1024, and an article image is the one place that is not
// enough — a figure broken out to 1200px on a retina display wants 2400, and
// capping at 1024 would make this change a visible regression against the
// bare <img src> it replaces.
func articleSrcset(barePath string, d imageDims, gen string) string {
	longest := d.width
	if d.height > longest {
		longest = d.height
	}

	var candidates []string
	for _, rung := range services.VariantSizes {
		if rung >= longest {
			break // VariantSizes is ascending
		}
		w := int(float64(rung) * (float64(d.width) / float64(longest)))
		if w < 1 {
			w = 1
		}
		candidates = append(candidates, services.VariantURL(barePath, rung, gen)+" "+strconv.Itoa(w)+"w")
	}
	if len(candidates) == 0 {
		// Every rung would upscale: the original is already the smallest thing
		// there is, and a one-candidate srcset says nothing src does not.
		return ""
	}
	return strings.Join(append(candidates, barePath+" "+strconv.Itoa(d.width)+"w"), ", ")
}

// injectArticleSrcset adds srcset + sizes to every post-body <img> whose
// source is a known-size image. src is never touched.
//
// media is the row set the caller already holds — every one of them fetched it
// for the response's `media` array — so this costs no query at all, let alone
// one per image.
func injectArticleSrcset(doc string, media []models.Medium, gen string) string {
	return injectArticleSrcsetDims(doc, articleImageDims(media), gen)
}

// injectArticleSrcsetDims is injectArticleSrcset over an already-built index,
// for the caller that renders many posts against one set of media rows and
// must not rebuild the map per post.
func injectArticleSrcsetDims(doc string, dims map[string]imageDims, gen string) string {
	if dims == nil || !strings.Contains(doc, "<img") {
		return doc
	}
	return articleImgTagRe.ReplaceAllStringFunc(doc, func(tag string) string {
		attrs := articleImgTagRe.FindStringSubmatch(tag)[1]
		if strings.Contains(strings.ToLower(attrs), "srcset=") {
			return tag
		}
		m := articleImgSrcRe.FindStringSubmatch(attrs)
		if m == nil {
			return tag
		}
		// A stored path may still carry the legacy `?thumb`; the media rows are
		// keyed on the bare path.
		src := m[1]
		if i := strings.IndexByte(src, '?'); i >= 0 {
			src = src[:i]
		}
		d, ok := dims[src]
		if !ok {
			return tag
		}
		srcset := articleSrcset(src, d, gen)
		if srcset == "" {
			return tag
		}
		return "<img" + attrs +
			` srcset="` + stdhtml.EscapeString(srcset) + `"` +
			` sizes="` + articleImageSizes + `">`
	})
}
