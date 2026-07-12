package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"

	attributes "github.com/mdigger/goldmark-attributes"
	"github.com/microcosm-cc/bluemonday"
	fences "github.com/stefanfritsch/goldmark-fences"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

type PostService struct {
	repo             repository.Repository
	settingsService  *SettingsService
	instagramService *InstagramService
	tagService       *TagService
	appURL           string
	md               goldmark.Markdown
	policy           *bluemonday.Policy
	viewBuffer       map[int64]int
	viewMu           sync.Mutex
}

func NewPostService(repo repository.Repository, settingsService *SettingsService, instagramService *InstagramService, tagService *TagService, appURL string) *PostService {
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

	return &PostService{
		repo:             repo,
		settingsService:  settingsService,
		instagramService: instagramService,
		tagService:       tagService,
		appURL:           strings.TrimSuffix(strings.TrimSpace(appURL), "/"),
		md:               md,
		policy:           policy,
		viewBuffer:       make(map[int64]int),
	}
}

// bareImageRe matches a line containing only a bare image path like /2026/02/file.jpg
var bareImageRe = regexp.MustCompile(`(?m)^(/\d{4}/\d{2}/\S+)$`)
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
			return fmt.Sprintf("![%s](%s)", path.Base(p), p)
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

// dangerousCSSRe matches CSS patterns that are unsafe to allow in per-post CSS blocks.
var (
	cssImportRe      = regexp.MustCompile(`(?i)@import\b[^;]*;?`)
	cssExternalURLRe = regexp.MustCompile(`(?i)url\s*\(\s*['"]?https?://[^)]*['"]?\s*\)`)
	cssPosFixedRe    = regexp.MustCompile(`(?i)\bposition\s*:\s*fixed\b`)
	cssPosStickyRe   = regexp.MustCompile(`(?i)\bposition\s*:\s*sticky\b`)
	cssZIndexRe      = regexp.MustCompile(`(?i)\bz-index\s*:[^;}]*`)
	cssDangerContent = regexp.MustCompile(`(?i)\bcontent\s*:[^;}]*`)
	cssScriptRe      = regexp.MustCompile(`(?i)<\s*script`)

	// Normalization regexes to defeat trivial denylist bypasses.
	cssCommentRe     = regexp.MustCompile(`/\*[\s\S]*?\*/`)                   // url(/**/https://…) comment splitting
	cssHexEscapeRe   = regexp.MustCompile(`\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?`) // \40 import → @import
	cssOtherEscapeRe = regexp.MustCompile(`\\([^0-9a-fA-F\r\n])`)            // \@import → @import
)

// normalizeCSSForSanitizing strips CSS comments and decodes CSS escape
// sequences so the denylist in SanitizePostCSS can't be evaded via
// comment-splitting or escaped characters.
// TODO(follow-up): replace the regex denylist with a real CSS parser; escape
// decoding here is a stopgap, not a complete CSS tokenizer.
func normalizeCSSForSanitizing(css string) string {
	css = cssCommentRe.ReplaceAllString(css, "")
	css = cssHexEscapeRe.ReplaceAllStringFunc(css, func(m string) string {
		h := cssHexEscapeRe.FindStringSubmatch(m)[1]
		n, err := strconv.ParseInt(h, 16, 32)
		if err != nil || n == 0 || n > 0x10FFFF {
			return ""
		}
		return string(rune(n))
	})
	return cssOtherEscapeRe.ReplaceAllString(css, "$1")
}

// SanitizePostCSS strips dangerous CSS declarations from per-post CSS blocks.
// Returns the sanitized CSS and a list of property names that were removed.
func SanitizePostCSS(css string) (string, []string) {
	if css == "" {
		return "", nil
	}

	var stripped []string

	type rule struct {
		re   *regexp.Regexp
		name string
	}
	rules := []rule{
		{cssImportRe, "@import"},
		{cssExternalURLRe, "url() with external resource"},
		{cssPosFixedRe, "position: fixed"},
		{cssPosStickyRe, "position: sticky"},
		{cssZIndexRe, "z-index"},
		{cssDangerContent, "content"},
		{cssScriptRe, "<script>"},
	}

	result := normalizeCSSForSanitizing(css)
	for _, r := range rules {
		if r.re.MatchString(result) {
			stripped = append(stripped, r.name)
			result = r.re.ReplaceAllString(result, "")
		}
	}

	return strings.TrimSpace(result), stripped
}

func normalizeImmersiveMode(mode string) string {
	switch mode {
	case "immersive", "non-immersive":
		return mode
	default:
		return "auto"
	}
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

type ListPostsParams struct {
        Page          int32
        PerPage       int32
        Status        string
        FeaturedOnly  bool
        IncludeDrafts bool
        IncludeHidden bool
        IncludePages  bool
        Search        string
        Tag           string
        YearFrom      int
        YearTo        int
        SortBy        string
}

func (s *PostService) ListPosts(ctx context.Context, p ListPostsParams) ([]models.Post, int64, error) {
	offset := (p.Page - 1) * p.PerPage

	var posts []models.Post
	var total int64
	var err error

	// "page" is a type, not a status. A status filter of "page" means "only
	// pages"; route it through the search query (which knows how to filter by
	// type) and drop the bogus status match.
	onlyPages := strings.EqualFold(p.Status, "page")
	if onlyPages {
		p.Status = ""
		posts, err = s.repo.ListPostsWithSearch(ctx, false, "", p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, "", "", true, int64(p.PerPage), int64(offset))
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsWithSearch(ctx, false, "", p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, "", "", true)
		if err != nil {
			return nil, 0, err
		}
		if posts == nil {
			posts = []models.Post{}
		}
		return posts, total, nil
	}

	countParams := models.CountPostsParams{
		StatusFilter:   p.Status != "",
		Status:         p.Status,
		FeaturedFilter: p.FeaturedOnly,
		IncludeDrafts:  p.IncludeDrafts,
		IncludeHidden:  p.IncludeHidden,
		IncludePages:   p.IncludePages,
	}

	if p.YearFrom > 0 && p.YearTo > 0 {
		repoParams := models.ListPostsParams{
			StatusFilter:   p.Status != "",
			Status:         p.Status,
			FeaturedFilter: p.FeaturedOnly,
			IncludeDrafts:  p.IncludeDrafts,
			Limit:          int64(p.PerPage),
			Offset:         int64(offset),
			IncludeHidden:  p.IncludeHidden,
		}
		posts, err = s.repo.ListPostsInYearRange(ctx, p.YearFrom, p.YearTo, repoParams)
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsInYearRange(ctx, p.YearFrom, p.YearTo, countParams)
	} else if p.Search != "" || p.Tag != "" {
	        posts, err = s.repo.ListPostsWithSearch(ctx, p.Status != "", p.Status, p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, p.Search, p.Tag, false, int64(p.PerPage), int64(offset))
	        if err != nil {
	                return nil, 0, err
	        }
	        total, err = s.repo.CountPostsWithSearch(ctx, p.Status != "", p.Status, p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, p.Search, p.Tag, false)
	} else {
		if p.SortBy == "views" {
			posts, err = s.repo.ListPostsByViews(ctx, models.ListPostsByViewsParams{
				StatusFilter:   p.Status != "",
				Status:         p.Status,
				FeaturedFilter: p.FeaturedOnly,
				IncludeDrafts:  p.IncludeDrafts,
				Limit:          int64(p.PerPage),
				Offset:         int64(offset),
				IncludeHidden:  p.IncludeHidden,
			})
		} else {
			posts, err = s.repo.ListPosts(ctx, models.ListPostsParams{
				StatusFilter:   p.Status != "",
				Status:         p.Status,
				FeaturedFilter: p.FeaturedOnly,
				IncludeDrafts:  p.IncludeDrafts,
				Limit:          int64(p.PerPage),
				Offset:         int64(offset),
				IncludeHidden:  p.IncludeHidden,
				IncludePages:   p.IncludePages,
			})
		}
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPosts(ctx, countParams)
	}
	if err != nil {
		return nil, 0, err
	}

	if posts == nil {
		posts = []models.Post{}
	}

	return posts, total, nil
}

func (s *PostService) GetPostAnalytics(ctx context.Context) (models.GetPostAnalyticsRow, error) {
	return s.repo.GetPostAnalytics(ctx)
}

func (s *PostService) GetPostByID(ctx context.Context, id int64) (models.Post, error) {
	return s.repo.GetPost(ctx, id)
}

func (s *PostService) GetPostBySlug(ctx context.Context, slug string) (models.Post, error) {
	post, err := s.repo.GetPostBySlug(ctx, strings.ToLower(slug))
	if err == nil {
		return post, nil
	}
	// Numeric fallback: /posts/<id> is the post's permanent URL (used as the
	// comment-thread key, which must survive slug changes). A real slug that
	// happens to be all digits wins over an ID of the same value.
	if id, convErr := strconv.ParseInt(slug, 10, 64); convErr == nil {
		return s.repo.GetPost(ctx, id)
	}
	return post, err
}

func (s *PostService) ListPublishedPostStubs(ctx context.Context) ([]repository.PostStub, error) {
	return s.repo.ListPublishedPostStubs(ctx)
}

type CreatePostParams struct {
	Title           string
	Content         string
	CSS             string
	ImmersiveMode   string
	InstagramShare  bool
	Excerpt         string
	Slug            string
	Formatter       string
	Status          string
	Type            string
	IsFeatured      bool
	AuthorID        int64
	ThumbnailPath   string
	MetaDescription string
	Tags            []string
	ScheduledAt     *time.Time
}

func (s *PostService) CreatePost(ctx context.Context, p CreatePostParams) (models.Post, []string, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Title)
	}

	sanitizedCSS, strippedProps := SanitizePostCSS(p.CSS)

	if p.Type == "" {
		p.Type = "post"
	}

	post, err := s.repo.CreatePost(ctx, models.CreatePostParams{
		Title:           p.Title,
		Slug:            p.Slug,
		Content:         normalizeContent(p.Content),
		Css:             sanitizedCSS,
		ImmersiveMode:   normalizeImmersiveMode(p.ImmersiveMode),
		InstagramShare:  p.InstagramShare,
		Excerpt:         sql.NullString{String: p.Excerpt, Valid: p.Excerpt != ""},
		Formatter:       p.Formatter,
		Status:          p.Status,
		Type:            p.Type,
		IsFeatured:      p.IsFeatured,
		AuthorID:        p.AuthorID,
		ThumbnailPath:   sql.NullString{String: p.ThumbnailPath, Valid: p.ThumbnailPath != ""},
		MetaDescription: sql.NullString{String: p.MetaDescription, Valid: p.MetaDescription != ""},
		ScheduledAt:     toNullTime(p.ScheduledAt),
	})
	if err != nil {
		return models.Post{}, strippedProps, err
	}

	// Store the derived list-preview URL so list/grid queries need not read the
	// full content body. Kept in sync here and in UpdatePost.
	mediaURL := utils.DeriveMediaURL(post.ThumbnailPath.String, post.Content)
	if err := s.repo.SetPostMediaURL(ctx, post.ID, mediaURL); err == nil {
		post.MediaURL = sql.NullString{String: mediaURL, Valid: true}
	}

	// Handle tags
	for _, tagName := range p.Tags {
		// This is a bit inefficient, but standard logic: find or create tag
		tag, err := s.repo.GetTagBySlug(ctx, utils.Slugify(tagName))
		if err != nil {
			// Create tag
			tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{
				Name: tagName,
				Slug: utils.Slugify(tagName),
			})
			if err != nil {
				continue
			}
		}

		_ = s.repo.AddTagToPost(ctx, models.AddTagToPostParams{
			PostID: post.ID,
			TagID:  tag.ID,
		})
	}

	// Update tag counts
	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil {
		s.tagService.Invalidate()
	}

	return post, strippedProps, nil
}

func (s *PostService) IncrementViewCount(ctx context.Context, id int64) error {
	s.viewMu.Lock()
	defer s.viewMu.Unlock()
	s.viewBuffer[id]++
	return nil
}

func (s *PostService) FlushViewCounts(ctx context.Context) error {
	s.viewMu.Lock()
	if len(s.viewBuffer) == 0 {
		s.viewMu.Unlock()
		return nil
	}
	// Copy and clear the buffer to minimize lock time
	toFlush := s.viewBuffer
	s.viewBuffer = make(map[int64]int)
	s.viewMu.Unlock()

	for id, count := range toFlush {
		if err := s.repo.AddPostViewCount(ctx, models.AddPostViewCountParams{
			ID:        id,
			ViewCount: int64(count),
		}); err != nil {
			// On error, we might lose these counts or we could try to re-add them to the buffer
			// For now, just log the error.
			fmt.Printf("failed to flush view count for post %d: %v\n", id, err)
		}
	}
	return nil
}

func (s *PostService) GetTagsForPost(ctx context.Context, postID int64) ([]models.Tag, error) {
	return s.repo.GetTagsForPost(ctx, postID)
}

func (s *PostService) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]repository.PostTagInfo, error) {
	return s.repo.GetTagsByPostIDs(ctx, postIDs)
}

type UpdatePostParams struct {
	ID              int64
	AuthorID        int64
	Title           string
	Content         string
	CSS             string
	ImmersiveMode   string
	InstagramShare  bool
	Excerpt         string
	Slug            string
	Formatter       string
	Status          string
	Type            string
	IsFeatured      bool
	ThumbnailPath   string
	MetaDescription string
	Tags            []string
	ScheduledAt     *time.Time
}

func (s *PostService) UpdatePost(ctx context.Context, p UpdatePostParams) (models.Post, []string, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Title)
	}

	sanitizedCSS, strippedProps := SanitizePostCSS(p.CSS)

	if p.Type == "" {
		p.Type = "post"
	}

	post, err := s.repo.UpdatePost(ctx, models.UpdatePostParams{
		Title:           p.Title,
		Slug:            p.Slug,
		Content:         normalizeContent(p.Content),
		Css:             sanitizedCSS,
		ImmersiveMode:   normalizeImmersiveMode(p.ImmersiveMode),
		InstagramShare:  p.InstagramShare,
		Excerpt:         sql.NullString{String: p.Excerpt, Valid: p.Excerpt != ""},
		Formatter:       p.Formatter,
		Status:          p.Status,
		Type:            p.Type,
		IsFeatured:      p.IsFeatured,
		ThumbnailPath:   sql.NullString{String: p.ThumbnailPath, Valid: p.ThumbnailPath != ""},
		MetaDescription: sql.NullString{String: p.MetaDescription, Valid: p.MetaDescription != ""},
		ID:              p.ID,
		AuthorID:        p.AuthorID,
		ScheduledAt:     toNullTime(p.ScheduledAt),
	})
	if err != nil {
		return models.Post{}, strippedProps, err
	}

	// Keep the denormalized list-preview URL in sync with the new content/thumbnail.
	mediaURL := utils.DeriveMediaURL(post.ThumbnailPath.String, post.Content)
	if err := s.repo.SetPostMediaURL(ctx, post.ID, mediaURL); err == nil {
		post.MediaURL = sql.NullString{String: mediaURL, Valid: true}
	}

	// Replace tags
	_ = s.repo.ClearPostTags(ctx, post.ID)
	for _, tagName := range p.Tags {
		tag, err := s.getOrCreateTag(ctx, tagName)
		if err != nil {
			continue
		}
		_ = s.repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: post.ID, TagID: tag.ID})
	}

	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil {
		s.tagService.Invalidate()
	}

	return post, strippedProps, nil
}

func (s *PostService) UpdatePostTags(ctx context.Context, postID int64, tagNames []string) error {
	// Verify the post exists.
	if _, err := s.repo.GetPost(ctx, postID); err != nil {
		return err
	}

	_ = s.repo.ClearPostTags(ctx, postID)
	for _, tagName := range tagNames {
		tag, err := s.getOrCreateTag(ctx, tagName)
		if err != nil {
			continue
		}
		_ = s.repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: postID, TagID: tag.ID})
	}

	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil {
		s.tagService.Invalidate()
	}
	return nil
}

// getOrCreateTag looks up a tag by slug, creating it (parentless, i.e. Unfiled) if absent.
func (s *PostService) getOrCreateTag(ctx context.Context, name string) (models.Tag, error) {
	slug := utils.Slugify(name)
	tag, err := s.repo.GetTagBySlug(ctx, slug)
	if err == nil {
		return tag, nil
	}
	tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{Name: name, Slug: slug})
	return tag, err
}

func (s *PostService) UpdatePostStatus(ctx context.Context, id int64, status string) (models.Post, error) {
	// Verify the post exists.
	post, err := s.repo.GetPost(ctx, id)
	if err != nil {
		return models.Post{}, err
	}

	// "page" is a UI shorthand for a published post of type=page. Map the
	// requested status onto the real (status, type) pair; any other status
	// turns a page back into a regular post.
	newStatus := strings.ToLower(status)
	newType := "post"
	if newStatus == "page" {
		newStatus = "published"
		newType = "page"
	}

	params := models.UpdatePostParams{
		ID:              post.ID,
		AuthorID:        post.AuthorID,
		Title:           post.Title,
		Slug:            post.Slug,
		Content:         post.Content,
		Css:             post.Css,
		ImmersiveMode:   post.ImmersiveMode,
		Excerpt:         post.Excerpt,
		Formatter:       post.Formatter,
		Status:          newStatus,
		Type:            newType,
		IsFeatured:      post.IsFeatured,
		ThumbnailPath:   post.ThumbnailPath,
		MetaDescription: post.MetaDescription,
		ScheduledAt:     post.ScheduledAt,
	}

	// published_at logic handled in repository.UpdatePost based on status
	post, err = s.repo.UpdatePost(ctx, params)
	if err == nil {
		_ = s.repo.UpdateAllTagPostCounts(ctx)
		if s.tagService != nil { s.tagService.Invalidate() }
	}
	return post, err
}

func (s *PostService) SoftDeletePost(ctx context.Context, id, authorID int64) error {
	if err := s.repo.SoftDeletePost(ctx, models.SoftDeletePostParams{ID: id, AuthorID: authorID}); err != nil {
		return err
	}
	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil {
		s.tagService.Invalidate()
	}
	return nil
}

func (s *PostService) RestorePost(ctx context.Context, id, authorID int64) error {
	if err := s.repo.RestorePost(ctx, models.RestorePostParams{ID: id, AuthorID: authorID}); err != nil {
		return err
	}
	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil {
		s.tagService.Invalidate()
	}
	return nil
}

func (s *PostService) PermanentlyDeletePost(ctx context.Context, id, authorID int64) error {
	if err := s.repo.DeletePost(ctx, models.DeletePostParams{ID: id, AuthorID: authorID}); err != nil {
		return err
	}
	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil {
		s.tagService.Invalidate()
	}
	return nil
}

func (s *PostService) ListTrashedPosts(ctx context.Context, page, perPage int32) ([]models.Post, int64, error) {
	offset := (page - 1) * perPage
	posts, err := s.repo.ListTrashedPosts(ctx, models.ListTrashedPostsParams{
		Limit:  int64(perPage),
		Offset: int64(offset),
	})
	if err != nil {
		return nil, 0, err
	}
	total, err := s.repo.CountTrashedPosts(ctx)
	if err != nil {
		return nil, 0, err
	}
	if posts == nil {
		posts = []models.Post{}
	}
	return posts, total, nil
}

func (s *PostService) PublishPost(ctx context.Context, id int64) (models.Post, error) {
	post, err := s.repo.PublishPost(ctx, id)
	if err != nil {
		return post, err
	}
	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil { s.tagService.Invalidate() }
	if s.settingsService != nil && post.InstagramShare {
		enabledStr, _ := s.settingsService.GetSetting(ctx, "enable_instagram", "false")
		if enabledStr == "true" || enabledStr == "1" {
			go func() {
				ctx2, cancel := context.WithTimeout(context.Background(), 180*time.Second)
				defer cancel()
				_ = s.CrossPostToInstagram(ctx2, id)
			}()
		}
	}
	return post, nil
}

func (s *PostService) WithdrawPost(ctx context.Context, id int64) (models.Post, error) {
	post, err := s.repo.WithdrawPost(ctx, id)
	if err == nil {
		_ = s.repo.UpdateAllTagPostCounts(ctx)
		if s.tagService != nil { s.tagService.Invalidate() }
	}
	return post, err
}

// GeneratePreviewLink creates a preview token for a post valid for 7 days.
// Returns the plain token and expiry time.
func (s *PostService) GeneratePreviewLink(ctx context.Context, postID int64) (string, time.Time, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(b)
	expiresAt := time.Now().Add(7 * 24 * time.Hour).UTC().Round(0)

	err := s.repo.SetPostPreviewToken(ctx, models.SetPostPreviewTokenParams{
		PreviewToken:     sql.NullString{String: token, Valid: true},
		PreviewExpiresAt: sql.NullTime{Time: expiresAt, Valid: true},
		ID:               postID,
	})
	if err != nil {
		return "", time.Time{}, err
	}
	return token, expiresAt, nil
}

// GetPostByPreviewToken returns a post if the token is valid and not expired.
func (s *PostService) GetPostByPreviewToken(ctx context.Context, token string) (models.Post, error) {
	post, err := s.repo.GetPostByPreviewToken(ctx, token)
	if err != nil {
		return models.Post{}, err
	}
	// Check expiry
	if post.PreviewExpiresAt.Valid && time.Now().After(post.PreviewExpiresAt.Time) {
		return models.Post{}, sql.ErrNoRows
	}
	return post, nil
}

// GetPostNavigation returns the previous and next published posts adjacent to
// the given post, ordered by published_at.
func (s *PostService) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool, tag string) (prev, next *repository.PostNavItem, err error) {
	return s.repo.GetPostNavigation(ctx, postID, publicOnly, tag)
}

func (s *PostService) PublishDueScheduledPosts(ctx context.Context) ([]models.Post, error) {
	published, err := s.repo.BulkPublishScheduledPosts(ctx)
	if err != nil {
		return nil, err
	}
	if len(published) > 0 {
		_ = s.repo.UpdateAllTagPostCounts(ctx)
		if s.tagService != nil { s.tagService.Invalidate() }
		fmt.Printf("Scheduled publishing: published %d post(s)\n", len(published))
		if s.settingsService != nil {
			enabledStr, _ := s.settingsService.GetSetting(ctx, "enable_instagram", "false")
			if enabledStr == "true" || enabledStr == "1" {
				for _, p := range published {
					if p.InstagramShare {
						id := p.ID
						go func() {
							ctx2, cancel := context.WithTimeout(context.Background(), 180*time.Second)
							defer cancel()
							_ = s.CrossPostToInstagram(ctx2, id)
						}()
					}
				}
			}
		}
	}
	return published, nil
}

// CrossPostToInstagram publishes a post's images to Instagram if enabled.
// It resolves absolute image URLs using APP_URL and builds a caption from a template.
func (s *PostService) CrossPostToInstagram(ctx context.Context, postID int64) error {
	post, err := s.repo.GetPost(ctx, postID)
	if err != nil {
		return err
	}

	if !post.InstagramShare {
		return nil
	}

	// 1. Validate APP_URL
	appURL := s.appURL
	if appURL == "" || strings.Contains(appURL, "localhost") {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", "APP_URL not configured or not public")
		return fmt.Errorf("instagram: APP_URL not public or empty")
	}

	// 2. Get images referenced in post content (by path, not post_id FK).
	paths := ExtractMediaPaths(post.Content, "")
	media, err := s.repo.GetMediaByPaths(ctx, paths)
	if err != nil {
		return err
	}

	var images []models.Medium
	for _, m := range media {
		if imageExtRe.MatchString(m.OriginalPath) {
			images = append(images, m)
		}
	}

	if len(images) == 0 {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", "Post has no images")
		return fmt.Errorf("instagram: post has no images")
	}

	// mediaURL converts a DB original_path ("originals/YYYY/MM/file") to a public URL.
	mediaURL := func(orig string) string {
		return appURL + strings.TrimPrefix(orig, "originals")
	}

	// 3. Build caption from template.
	template, _ := s.settingsService.GetSetting(ctx, "instagram_caption_template", "{title}\n\n{excerpt}\n\n{tags}\n\n{link}")
	caption := s.expandCaptionTemplate(ctx, template, post, appURL)

	// 4. Create and publish containers.
	var creationID string
	if len(images) == 1 {
		creationID, err = s.instagramService.CreateImageContainer(ctx, mediaURL(images[0].OriginalPath), caption)
		if err == nil {
			err = s.instagramService.WaitForContainerReady(ctx, creationID)
		}
	} else {
		if len(images) > 10 {
			images = images[:10]
		}
		var childIDs []string
		for _, img := range images {
			childID, err := s.instagramService.CreateCarouselChild(ctx, mediaURL(img.OriginalPath))
			if err != nil {
				_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
				return err
			}
			if err := s.instagramService.WaitForContainerReady(ctx, childID); err != nil {
				_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
				return err
			}
			childIDs = append(childIDs, childID)
		}
		creationID, err = s.instagramService.CreateCarousel(ctx, childIDs, caption)
		if err == nil {
			err = s.instagramService.WaitForContainerReady(ctx, creationID)
		}
	}

	if err != nil {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
		return err
	}

	mediaID, err := s.instagramService.PublishContainer(ctx, creationID)
	if err != nil {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
		return err
	}

	return s.updateInstagramStatus(ctx, post.ID, "published", mediaID, "")
}

func (s *PostService) expandCaptionTemplate(ctx context.Context, template string, post models.Post, appURL string) string {
	res := template
	res = strings.ReplaceAll(res, "{title}", post.Title)

	excerpt := post.Excerpt.String
	res = strings.ReplaceAll(res, "{excerpt}", excerpt)

	link := fmt.Sprintf("%s/posts/%s", appURL, post.Slug)
	res = strings.ReplaceAll(res, "{link}", link)

	tags, _ := s.repo.GetTagsForPost(ctx, post.ID)
	var tagStrings []string
	for _, t := range tags {
		tagStrings = append(tagStrings, "#"+t.Name)
	}
	res = strings.ReplaceAll(res, "{tags}", strings.Join(tagStrings, " "))

	return res
}

func (s *PostService) updateInstagramStatus(ctx context.Context, postID int64, status, mediaID, errMsg string) error {
	var publishedAt sql.NullTime
	if status == "published" {
		publishedAt = sql.NullTime{Time: time.Now().UTC(), Valid: true}
	}

	return s.repo.UpdatePostInstagramStatus(ctx, models.UpdatePostInstagramStatusParams{
		ID:                   postID,
		InstagramStatus:      status,
		InstagramMediaID:     sql.NullString{String: mediaID, Valid: mediaID != ""},
		InstagramPublishedAt: publishedAt,
		InstagramError:       sql.NullString{String: errMsg, Valid: errMsg != ""},
	})
}

func toNullTime(t *time.Time) sql.NullTime {
	if t == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t.UTC(), Valid: true}
}
