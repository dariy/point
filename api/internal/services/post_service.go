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
	highlighting "github.com/yuin/goldmark-highlighting/v2"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
)

type PostService struct {
	repo             repository.Repository
	settingsService  *SettingsService
	instagramService *InstagramService
	md               goldmark.Markdown
	policy           *bluemonday.Policy
	viewBuffer       map[int64]int
	viewMu           sync.Mutex
}

func NewPostService(repo repository.Repository, settingsService *SettingsService, instagramService *InstagramService) *PostService {
	md := goldmark.New(
		goldmark.WithExtensions(
			extension.GFM,
			extension.Typographer,
			attributes.Extension,
			&fences.Extender{},
			highlighting.NewHighlighting(
				highlighting.WithStyle("monokai"),
			),
		),
		goldmark.WithParserOptions(
			parser.WithAutoHeadingID(),
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

// markdownImageRe matches a markdown image whose src starts with /media/originals
// (legacy format written before the URL refactor). Capture group 1 is the path
// after that prefix, i.e. "/YYYY/MM/file" — the bare-path storage format.
var markdownImageRe = regexp.MustCompile(`!\[[^\]]*\]\(/media/originals(/[^)]+)\)`)

// preprocessContent expands bare image/video/audio paths into markdown or HTML syntax
// so goldmark renders them as <img>, <video>, or <audio> tags.
// e.g. /2026/02/photo.jpg → ![photo.jpg](/2026/02/photo.jpg)
func preprocessContent(content string) string {
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
)

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

	result := css
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
	return s.policy.Sanitize(buf.String()), nil
}

type ListPostsParams struct {
	Page          int32
	PerPage       int32
	Status        string
	FeaturedOnly  bool
	IncludeDrafts bool
	IncludeHidden bool
	Search        string
	YearFrom      int
	YearTo        int
	SortBy        string
}

func (s *PostService) ListPosts(ctx context.Context, p ListPostsParams) ([]models.Post, int64, error) {
	offset := (p.Page - 1) * p.PerPage

	var posts []models.Post
	var total int64
	var err error

	countParams := models.CountPostsParams{
		StatusFilter:   p.Status != "",
		Status:         p.Status,
		FeaturedFilter: p.FeaturedOnly,
		IncludeDrafts:  p.IncludeDrafts,
		IncludeHidden:  p.IncludeHidden,
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
	} else if p.Search != "" {
		posts, err = s.repo.ListPostsWithSearch(ctx, p.Status != "", p.Status, p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, p.Search, int64(p.PerPage), int64(offset))
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsWithSearch(ctx, p.Status != "", p.Status, p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, p.Search)
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
	return s.repo.GetPostBySlug(ctx, strings.ToLower(slug))
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
		IsFeatured:      p.IsFeatured,
		AuthorID:        p.AuthorID,
		ThumbnailPath:   sql.NullString{String: p.ThumbnailPath, Valid: p.ThumbnailPath != ""},
		MetaDescription: sql.NullString{String: p.MetaDescription, Valid: p.MetaDescription != ""},
		ScheduledAt:     toNullTime(p.ScheduledAt),
	})
	if err != nil {
		return models.Post{}, strippedProps, err
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
	return nil
}

// getOrCreateTag looks up a tag by slug, creating it if absent and auto-assigning _pending.
func (s *PostService) getOrCreateTag(ctx context.Context, name string) (models.Tag, error) {
	slug := utils.Slugify(name)
	tag, err := s.repo.GetTagBySlug(ctx, slug)
	if err == nil {
		return tag, nil
	}
	tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{Name: name, Slug: slug})
	if err != nil {
		return tag, err
	}
	// Auto-assign to _pending so new tags appear in the admin tree.
	if pending, perr := s.repo.GetTagBySlug(ctx, "_pending"); perr == nil {
		_ = s.repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
			ParentID: pending.ID,
			ChildID:  tag.ID,
		})
	}
	return tag, nil
}

func (s *PostService) SoftDeletePost(ctx context.Context, id, authorID int64) error {
	return s.repo.SoftDeletePost(ctx, models.SoftDeletePostParams{ID: id, AuthorID: authorID})
}

func (s *PostService) RestorePost(ctx context.Context, id, authorID int64) error {
	return s.repo.RestorePost(ctx, models.RestorePostParams{ID: id, AuthorID: authorID})
}

func (s *PostService) PermanentlyDeletePost(ctx context.Context, id, authorID int64) error {
	return s.repo.DeletePost(ctx, models.DeletePostParams{ID: id, AuthorID: authorID})
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
	return s.repo.PublishPost(ctx, id)
}

func (s *PostService) WithdrawPost(ctx context.Context, id int64) (models.Post, error) {
	return s.repo.WithdrawPost(ctx, id)
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
func (s *PostService) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool) (prev, next *repository.PostNavItem, err error) {
	return s.repo.GetPostNavigation(ctx, postID, publicOnly)
}

func (s *PostService) PublishDueScheduledPosts(ctx context.Context) ([]models.Post, error) {
	published, err := s.repo.BulkPublishScheduledPosts(ctx)
	if err != nil {
		return nil, err
	}
	if len(published) > 0 {
		_ = s.repo.UpdateAllTagPostCounts(ctx)
		fmt.Printf("Scheduled publishing: published %d post(s)\n", len(published))
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
	appURL, _ := s.settingsService.GetSetting(ctx, "app_url", "")
	if appURL == "" || strings.Contains(appURL, "localhost") {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", "APP_URL not configured or not public")
		return fmt.Errorf("instagram: APP_URL not public or empty")
	}
	appURL = strings.TrimSuffix(appURL, "/")

	// 2. Get images
	media, err := s.repo.GetMediaByPostID(ctx, sql.NullInt64{Int64: post.ID, Valid: true})
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

	// 3. Build caption
	template, _ := s.settingsService.GetSetting(ctx, "instagram_caption_template", "{title}\n\n{excerpt}\n\n{tags}\n\n{link}")
	caption := s.expandCaptionTemplate(ctx, template, post, appURL)

	// 4. Create and Publish Containers
	var creationID string
	if len(images) == 1 {
		imageURL := appURL + images[0].OriginalPath
		creationID, err = s.instagramService.CreateImageContainer(ctx, imageURL, caption)
	} else {
		if len(images) > 10 {
			images = images[:10]
		}
		var childIDs []string
		for _, img := range images {
			imageURL := appURL + img.OriginalPath
			childID, err := s.instagramService.CreateCarouselChild(ctx, imageURL)
			if err != nil {
				_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
				return err
			}
			childIDs = append(childIDs, childID)
		}
		creationID, err = s.instagramService.CreateCarousel(ctx, childIDs, caption)
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
	if excerpt == "" {
		excerpt = ""
	}
	res = strings.ReplaceAll(res, "{excerpt}", excerpt)

	link := fmt.Sprintf("%s/%s", appURL, post.Slug)
	res = strings.ReplaceAll(res, "{link}", link)

	tags, _ := s.repo.GetTagsForPost(ctx, post.ID)
	var tagStrings []string
	for _, t := range tags {
		if !strings.HasPrefix(t.Slug, "_") {
			tagStrings = append(tagStrings, "#"+t.Name)
		}
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
