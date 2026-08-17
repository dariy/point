package services

import (
	"bytes"
	"fmt"
	"path"
	"regexp"
	"strings"

	attributes "github.com/mdigger/goldmark-attributes"
	"github.com/microcosm-cc/bluemonday"
	fences "github.com/stefanfritsch/goldmark-fences"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

// newPostMarkdown builds the goldmark pipeline a post body is rendered with.
func newPostMarkdown() goldmark.Markdown {
	var blockParsers []util.PrioritizedValue
	for _, p := range parser.DefaultBlockParsers() {
		if p.Priority != 100 {
			blockParsers = append(blockParsers, p)
		}
	}
	customParser := parser.NewParser(
		parser.WithBlockParsers(blockParsers...),
		parser.WithInlineParsers(parser.DefaultInlineParsers()...),
		parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
		parser.WithAutoHeadingID(),
	)

	md := goldmark.New(
		goldmark.WithParser(customParser),
		goldmark.WithExtensions(
			extension.GFM,
			extension.Typographer,
			attributes.Extension,
			&fences.Extender{},
		),
		goldmark.WithRendererOptions(
			html.WithHardWraps(),
			html.WithXHTML(),
			html.WithUnsafe(),
		),
	)

	return md
}

// newPostPolicy builds the bluemonday allowlist applied to the rendered HTML.
func newPostPolicy() *bluemonday.Policy {
	// Initialize sanitization policy
	policy := bluemonday.NewPolicy()

	// Standard text elements
	policy.AllowElements("br", "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "em", "strong", "i", "b", "u", "s", "del", "ins", "mark")
	policy.AllowElements("ul", "ol", "li", "blockquote", "code", "pre", "hr")

	// Structural elements for landing pages
	policy.AllowElements("header", "section", "div", "article", "aside", "main", "nav")

	// Links
	policy.AllowAttrs("href", "title", "target", "rel").OnElements("a")

	// Restrict URL schemes on all href/src attributes. Without this, bluemonday
	// leaves requireParseableURLs false and passes javascript:/data:text/html
	// through unsanitized — harmless under CSP in-browser, but dangerous in
	// RSS/feed-reader/email contexts. data: is deliberately NOT allowed: no post
	// content relies on data: images, and allowing it would re-open
	// data:text/html on anchors. Relative URLs (bare media paths like
	// /2026/02/photo.jpg) stay permitted via AllowStandardURLs.
	policy.AllowStandardURLs()
	policy.AllowURLSchemes("http", "https", "mailto")
	policy.RequireNoFollowOnLinks(true)

	// Media elements
	policy.AllowElements("img", "video", "audio", "source", "figure", "figcaption")
	policy.AllowAttrs("src", "alt", "title", "width", "height", "loading").OnElements("img")
	policy.AllowAttrs("src", "type").OnElements("source")
	policy.AllowAttrs("src", "controls", "autoplay", "muted", "loop", "playsinline", "poster", "preload", "width", "height").OnElements("video")
	policy.AllowAttrs("src", "controls", "autoplay", "loop", "preload").OnElements("audio")

	policy.AllowAttrs("class", "id").OnElements(
		"header", "section", "div", "article", "aside", "main", "nav",
		"h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "span", "em", "strong",
		"ul", "ol", "li", "blockquote", "code", "pre", "hr",
		"img", "video", "audio", "source", "figure", "figcaption",
	)

	// SVG Support
	policy.AllowElements("svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "tspan")
	policy.AllowAttrs(
		"viewBox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
		"d", "cx", "cy", "r", "x", "y", "width", "height", "rx", "ry", "x1", "y1", "x2", "y2",
		"points", "transform", "opacity", "aria-hidden", "role", "aria-label",
	).OnElements("svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "tspan")

	// Metadata and Accessibility
	policy.AllowAttrs("aria-hidden", "role", "aria-label", "aria-labelledby", "aria-describedby").OnElements(
		"header", "section", "div", "article", "aside", "main", "nav",
		"h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "span",
	)

	// Inline style attributes — restricted to safe visual properties only.
	// Excludes position, z-index, background-image, content, transform, animation.
	policy.AllowStyles(
		"color", "background-color", "background",
		"font-size", "font-weight", "font-style", "font-family", "font-variant",
		"text-align", "text-decoration", "text-transform", "text-indent",
		"line-height", "letter-spacing", "word-spacing",
		"margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
		"padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
		"border", "border-radius", "border-color", "border-width", "border-style",
		"width", "max-width", "min-width", "height", "max-height", "min-height",
		"display", "flex-direction", "flex-wrap", "justify-content", "align-items",
		"align-self", "flex", "gap", "grid-template-columns",
		"float", "clear", "overflow", "overflow-x", "overflow-y",
		"opacity", "vertical-align", "list-style", "white-space",
	).Globally()

	return policy
}

// bareImageRe matches a line containing only a bare image path like /2026/02/file.jpg
var bareImageRe = regexp.MustCompile(`(?m)^(/\d{4}/\d{2}/[^\n\r]+)$`)
var imageExtRe = regexp.MustCompile(`(?i)\.(jpg|jpeg|png|gif|webp|avif|svg|heic|heif|bmp)$`)
var videoExtRe = regexp.MustCompile(`(?i)\.(mp4|webm|mov|ogv|m4v|avi|mkv)$`)
var audioExtRe = regexp.MustCompile(`(?i)\.(mp3|m4a|ogg|wav|flac|aac|opus)$`)

// setextH1Re matches a non-empty line immediately followed by a setext h1 underline (===).
// Converted to ATX-style heading since the setext parser is disabled and === would
// otherwise render as a literal paragraph.
var setextH1Re = regexp.MustCompile(`(?m)^([^\n\r]+)\n(=+[ \t]*)$`)

// markdownImageRe matches a markdown image whose src starts with /media/originals
// (legacy format written before the URL refactor). Capture group 1 is the path
// after that prefix, i.e. "/YYYY/MM/file" — the bare-path storage format.
var markdownImageRe = regexp.MustCompile(`!\[[^\]]*\]\(/media/originals(/[^)]+)\)`)

// preprocessContent expands bare image/video/audio paths into markdown or HTML syntax
// so goldmark renders them as <img>, <video>, or <audio> tags.
// e.g. /2026/02/photo.jpg → ![photo.jpg](/2026/02/photo.jpg)
// It also converts setext h1 (===) to ATX style since the setext parser is disabled.
func preprocessContent(content string) string {
	content = setextH1Re.ReplaceAllStringFunc(content, func(m string) string {
		matches := setextH1Re.FindStringSubmatch(m)
		return "# " + strings.TrimSpace(matches[1])
	})
	return bareImageRe.ReplaceAllStringFunc(content, func(p string) string {
		if imageExtRe.MatchString(p) {
			return fmt.Sprintf("![%s](<%s>)", path.Base(p), p)
		}
		if videoExtRe.MatchString(p) {
			return fmt.Sprintf("<video src=\"%s\" controls></video>", p)
		}
		if audioExtRe.MatchString(p) {
			return fmt.Sprintf("<audio src=\"%s\" controls></audio>", p)
		}
		return p
	})
}

// normalizeContent converts verbose markdown image syntax back to bare paths
// before storing in the database. Handles the legacy /media/originals/… prefix
// for backward compatibility with any content saved before the URL refactor.
// e.g. ![alt](/media/originals/2026/02/photo.jpg) → /2026/02/photo.jpg
func normalizeContent(content string) string {
	return markdownImageRe.ReplaceAllString(content, "$1")
}

func (s *PostService) RenderContent(content string) (string, error) {
	var buf bytes.Buffer
	if err := s.md.Convert([]byte(preprocessContent(content)), &buf); err != nil {
		return "", err
	}
	return addImgLoadingHints(s.policy.Sanitize(buf.String())), nil
}

// imgTagRe matches an <img …> tag, capturing its attributes in group 1 and
// tolerating the self-closing XHTML form (…/>) goldmark emits.
var imgTagRe = regexp.MustCompile(`(?i)<img\b([^>]*?)\s*/?>`)

// addImgLoadingHints adds loading="lazy" and decoding="async" to post-body
// <img> tags that don't already set them, so image-heavy posts don't fetch and
// decode every photo up front. Runs after sanitization, so bluemonday never
// strips the added attributes. Native lazy-loading still fetches images already
// in (or near) the viewport, so the first image isn't needlessly deferred.
func addImgLoadingHints(html string) string {
	return imgTagRe.ReplaceAllStringFunc(html, func(tag string) string {
		attrs := imgTagRe.FindStringSubmatch(tag)[1]
		lower := strings.ToLower(attrs)
		if !strings.Contains(lower, "loading=") {
			attrs += ` loading="lazy"`
		}
		if !strings.Contains(lower, "decoding=") {
			attrs += ` decoding="async"`
		}
		return "<img" + attrs + ">"
	})
}
