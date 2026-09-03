package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"point-api/internal/metrics"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
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
	// health records background cross-post outcomes for the admin health
	// view. Nil is valid and records nothing.
	health *HealthRegistry
	// cache is the public page cache a post write invalidates. Nil is valid
	// and simply skips the invalidation.
	cache *CacheService
	// metrics counts view-count flush losses. Nil is valid and counts nothing,
	// which is what METRICS_ENABLED=false leaves here.
	metrics *metrics.Registry
}

// WithMetrics attaches the metrics registry. The only thing counted here is a
// lost view count: FlushViewCounts drops a post's buffered views when the write
// fails, and that loss was previously visible only as one log line.
func (s *PostService) WithMetrics(m *metrics.Registry) *PostService {
	s.metrics = m
	return s
}

// PendingViewCounts is how many posts have views buffered in memory and not yet
// written back. Read at scrape time rather than mirrored into a counter: the
// buffer is already the authority, and a second copy could only disagree with
// it.
func (s *PostService) PendingViewCounts() int {
	s.viewMu.Lock()
	defer s.viewMu.Unlock()
	return len(s.viewBuffer)
}

// WithHealth attaches a health registry so background cross-post outcomes are
// visible to the admin health endpoint.
func (s *PostService) WithHealth(h *HealthRegistry) *PostService {
	s.health = h
	return s
}

// WithCache attaches the public page cache so a post write can drop it — see
// onPostsChanged. Without it the cache is only aged out by its TTL, and a post
// that has just been hidden keeps appearing in a cached feed for minutes after
// it stops being readable.
func (s *PostService) WithCache(c *CacheService) *PostService {
	s.cache = c
	return s
}

func NewPostService(repo repository.Repository, settingsService *SettingsService, instagramService *InstagramService, tagService *TagService, appURL string) *PostService {
	return &PostService{
		repo:             repo,
		settingsService:  settingsService,
		instagramService: instagramService,
		tagService:       tagService,
		appURL:           strings.TrimSuffix(strings.TrimSpace(appURL), "/"),
		md:               newPostMarkdown(),
		policy:           newPostPolicy(),
		viewBuffer:       make(map[int64]int),
	}
}

func normalizeImmersiveMode(mode string) string {
	switch mode {
	case "immersive", "non-immersive":
		return mode
	default:
		return "auto"
	}
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

// ListScheduledPosts returns one page of the scheduled queue (soonest first)
// along with the queue's total length. `page` is 1-based within the queue —
// the home feed maps its non-positive page numbers onto it (see the
// scheduledPageOffset comment in api/pages.go).
//
// It is a deliberately separate read rather than a flag on ListPostsParams:
// the ordering is the opposite of the feed's, and the two lists are never
// interleaved on one page.
func (s *PostService) ListScheduledPosts(ctx context.Context, page, perPage int32) ([]models.Post, int64, error) {
	if page < 1 {
		page = 1
	}
	offset := int64(page-1) * int64(perPage)
	posts, err := s.repo.ListScheduledPosts(ctx, int64(perPage), offset)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.repo.CountScheduledPosts(ctx)
	if err != nil {
		return nil, 0, err
	}
	if posts == nil {
		posts = []models.Post{}
	}
	return posts, total, nil
}

// CountScheduledPosts is the queue length on its own — the home feed needs it
// on every page to know how far left the reader may swipe.
func (s *PostService) CountScheduledPosts(ctx context.Context) (int64, error) {
	return s.repo.CountScheduledPosts(ctx)
}

// CountPostsOnly is the total ListPosts would report for the same filters
// without reading a page of rows. The home feed needs it while rendering a
// scheduled page, where the posts come from the queue but the paginator still
// has to describe the published feed behind it. It covers the unfiltered
// branch only — the one the home feed uses — since a year scope or a search
// never coexists with the scheduled queue.
func (s *PostService) CountPostsOnly(ctx context.Context, p ListPostsParams) (int64, error) {
	return s.repo.CountPosts(ctx, models.CountPostsParams{
		StatusFilter:   p.Status != "",
		Status:         p.Status,
		FeaturedFilter: p.FeaturedOnly,
		IncludeDrafts:  p.IncludeDrafts,
		IncludeHidden:  p.IncludeHidden,
		IncludePages:   p.IncludePages,
	})
}

func (s *PostService) GetPostAnalytics(ctx context.Context) (models.GetPostAnalyticsRow, error) {
	return s.repo.GetPostAnalytics(ctx)
}

// ErrPostNotFound replaces the driver's sql.ErrNoRows on the post read paths.
// A named sentinel rather than a wrap of ErrNoRows because this message reaches
// clients through the central mapper, and "sql: no rows in result set" is not
// something to answer a request with.
var ErrPostNotFound = kindSentinel(ErrNotFound, "post not found")

func (s *PostService) GetPostByID(ctx context.Context, id int64) (models.Post, error) {
	return s.getPost(ctx, id)
}

// getPost fetches one post row, translating a missing row into ErrPostNotFound.
func (s *PostService) getPost(ctx context.Context, id int64) (models.Post, error) {
	post, err := s.repo.GetPost(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Post{}, ErrPostNotFound
	}
	return post, err
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
		return s.getPost(ctx, id)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return models.Post{}, ErrPostNotFound
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

// classifyPostSaveError classifies the two foreseeable ways a post save fails.
//
// A slug collision is a conflict. SQLite reports it only in the driver's
// message, so the text is matched here — once — instead of in every handler;
// the message is passed through unchanged so the handler can still substitute a
// friendlier one.
//
// UpdatePost's statement matches on (id, author_id), so no rows means the post
// is absent or belongs to someone else. Those are reported identically on
// purpose: distinguishing them would tell a caller that someone else's post
// exists.
func classifyPostSaveError(err error) error {
	switch {
	case err == nil:
		return nil
	case isSlugConflict(err):
		return wrapKind(ErrConflict, err)
	case errors.Is(err, sql.ErrNoRows):
		return ErrPostNotFound
	default:
		return err
	}
}

func isSlugConflict(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed: posts.slug")
}

// autoTitle is the title given to a post saved without one: today's date, in
// the pattern the admin chose in /light/settings.
func (s *PostService) autoTitle(ctx context.Context) string {
	format := DefaultPostTitleFormat
	if s.settingsService != nil {
		if v, err := s.settingsService.GetSetting(ctx, DefaultPostTitleFormatKey, DefaultPostTitleFormat); err == nil && strings.TrimSpace(v) != "" {
			format = v
		}
	}
	title := FormatTitleDate(format, time.Now())
	if title == "" {
		// A pattern of only whitespace would leave the post untitled again.
		title = FormatTitleDate(DefaultPostTitleFormat, time.Now())
	}
	return title
}

func (s *PostService) CreatePost(ctx context.Context, p CreatePostParams) (models.Post, []string, error) {
	// A post saved without a title is titled after the day it was written, so
	// nothing is ever stored as an unnamed row.
	autoTitled := strings.TrimSpace(p.Title) == ""
	if autoTitled {
		p.Title = s.autoTitle(ctx)
	}

	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Title)
	}

	sanitizedCSS, strippedProps := SanitizePostCSS(p.CSS)

	if p.Type == "" {
		p.Type = "post"
	}

	params := models.CreatePostParams{
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
	}
	post, err := s.repo.CreatePost(ctx, params)
	// Every untitled post written on the same day derives the same date slug
	// (and a trashed post keeps its slug reserved), so suffix instead of
	// failing a save the author was never asked to name.
	baseSlug := params.Slug
	for n := 2; n <= 100 && autoTitled && isSlugConflict(err); n++ {
		params.Slug = fmt.Sprintf("%s-%d", baseSlug, n)
		post, err = s.repo.CreatePost(ctx, params)
	}
	if err != nil {
		return models.Post{}, strippedProps, classifyPostSaveError(err)
	}

	// Store the derived list-preview URL so list/grid queries need not read the
	// full content body. Kept in sync here and in UpdatePost.
	mediaURL := utils.DeriveMediaURL(post.ThumbnailPath.String, post.Content)
	if err := s.repo.SetPostMediaURL(ctx, post.ID, mediaURL); err == nil {
		post.MediaURL = sql.NullString{String: mediaURL, Valid: true}
	}

	// Handle tags: resolve them all in one query, then only create the ones
	// that are genuinely new (normally none).
	slugs := make([]string, 0, len(p.Tags))
	for _, tagName := range p.Tags {
		slugs = append(slugs, utils.Slugify(tagName))
	}
	existing, err := s.repo.FindTagsBySlugs(ctx, slugs)
	if err != nil {
		return models.Post{}, strippedProps, err
	}
	for i, tagName := range p.Tags {
		tag, ok := existing[slugs[i]]
		if !ok {
			tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{
				Name: tagName,
				Slug: slugs[i],
			})
			if err != nil {
				continue
			}
			// Two tag names can slugify to the same slug; remember the created
			// tag so the duplicate resolves to it instead of failing to insert.
			existing[slugs[i]] = tag
		}

		_ = s.repo.AddTagToPost(ctx, models.AddTagToPostParams{
			PostID: post.ID,
			TagID:  tag.ID,
		})
	}

	s.onPostsChanged(ctx)

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
			slog.Error("failed to flush view count", "post_id", id, "error", err)
			s.metrics.ViewFlushFailure()
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
	// Clearing the title of an already-titled post keeps the old one (the
	// handler merges it back in); this covers the rest — a post that reaches an
	// update still untitled gets the same date title a new one would.
	if strings.TrimSpace(p.Title) == "" {
		p.Title = s.autoTitle(ctx)
	}

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
		return models.Post{}, strippedProps, classifyPostSaveError(err)
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

	s.onPostsChanged(ctx)

	return post, strippedProps, nil
}

func (s *PostService) UpdatePostTags(ctx context.Context, postID int64, tagNames []string) error {
	// Verify the post exists.
	if _, err := s.getPost(ctx, postID); err != nil {
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

	s.onPostsChanged(ctx)
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
	post, err := s.getPost(ctx, id)
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
		s.onPostsChanged(ctx)
	}
	return post, err
}

func (s *PostService) SoftDeletePost(ctx context.Context, id, authorID int64) error {
	if err := s.repo.SoftDeletePost(ctx, models.SoftDeletePostParams{ID: id, AuthorID: authorID}); err != nil {
		return err
	}
	s.onPostsChanged(ctx)
	return nil
}

func (s *PostService) RestorePost(ctx context.Context, id, authorID int64) error {
	if err := s.repo.RestorePost(ctx, models.RestorePostParams{ID: id, AuthorID: authorID}); err != nil {
		return err
	}
	s.onPostsChanged(ctx)
	return nil
}

func (s *PostService) PermanentlyDeletePost(ctx context.Context, id, authorID int64) error {
	if err := s.repo.DeletePost(ctx, models.DeletePostParams{ID: id, AuthorID: authorID}); err != nil {
		return err
	}
	s.onPostsChanged(ctx)
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
		if errors.Is(err, sql.ErrNoRows) {
			return models.Post{}, ErrPostNotFound
		}
		return models.Post{}, err
	}
	// An expired token is indistinguishable from a bad one to the caller, by
	// design: neither should confirm that a draft exists.
	if post.PreviewExpiresAt.Valid && time.Now().After(post.PreviewExpiresAt.Time) {
		return models.Post{}, ErrPostNotFound
	}
	return post, nil
}

// GetPostNavigation returns the previous and next published posts adjacent to
// the given post, ordered by published_at.
func (s *PostService) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool, tag string) (prev, next *repository.PostNavItem, err error) {
	prev, next, err = s.repo.GetPostNavigation(ctx, postID, publicOnly, tag)
	if errors.Is(err, sql.ErrNoRows) {
		// The anchor post itself is missing. Having no neighbours is not an
		// error — it comes back as two nil items.
		return nil, nil, ErrPostNotFound
	}
	return prev, next, err
}

func toNullTime(t *time.Time) sql.NullTime {
	if t == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t.UTC(), Valid: true}
}

// postLinkRe matches internal post links (/posts/<slug>) in raw post content —
// markdown targets, href attributes, or bare paths alike.
var postLinkRe = regexp.MustCompile(`/posts/([A-Za-z0-9._-]+)`)

// PostLinkIssue describes an internal link on a publicly reachable post whose
// target an anonymous visitor cannot open.
type PostLinkIssue struct {
	SourceID    int64  `json:"source_id"`
	SourceSlug  string `json:"source_slug"`
	SourceTitle string `json:"source_title"`
	TargetSlug  string `json:"target_slug"`
	Reason      string `json:"reason"`
}

// AuditPublicPostLinks scans every publicly reachable post (published and not
// hidden directly or via a hides-posts tag) for internal /posts/<slug> links
// whose target is missing, unpublished, or hidden — the failure mode where an
// index post looks fine to a logged-in admin while every link 404s for
// visitors. Returns the issues and the number of posts scanned.
func (s *PostService) AuditPublicPostLinks(ctx context.Context) ([]PostLinkIssue, int, error) {
	rows, err := s.repo.ListPostLinkAuditRows(ctx)
	if err != nil {
		return nil, 0, err
	}

	var effectiveHides map[int64]bool
	tagName := map[int64]string{}
	if s.tagService != nil {
		if snap, err := s.tagService.GetTagSnapshot(ctx); err == nil && snap != nil {
			effectiveHides = snap.EffectiveHidesPosts
			for id, t := range snap.ByID {
				tagName[id] = t.Name
			}
		}
	}

	type target struct {
		status    string
		hiddenVia []string // names of tags that effectively hide the post
	}
	bySlug := make(map[string]target, len(rows))
	for _, r := range rows {
		t := target{status: r.Status}
		for _, tid := range r.TagIDs {
			if effectiveHides[tid] {
				t.hiddenVia = append(t.hiddenVia, tagName[tid])
			}
		}
		bySlug[strings.ToLower(r.Slug)] = t
	}

	issues := []PostLinkIssue{}
	scanned := 0
	seen := map[string]bool{} // "<sourceID>:<targetSlug>" dedupe
	for _, r := range rows {
		src := bySlug[strings.ToLower(r.Slug)]
		if src.status != "published" || len(src.hiddenVia) > 0 {
			continue // only links on publicly reachable posts matter
		}
		scanned++
		for _, m := range postLinkRe.FindAllStringSubmatch(r.Content, -1) {
			slug := strings.ToLower(m[1])
			if slug == strings.ToLower(r.Slug) {
				continue
			}
			key := strconv.FormatInt(r.ID, 10) + ":" + slug
			if seen[key] {
				continue
			}
			seen[key] = true

			tgt, ok := bySlug[slug]
			var reason string
			switch {
			case !ok:
				reason = "target not found (deleted or slug typo)"
			case len(tgt.hiddenVia) > 0:
				reason = "target hidden by tag '" + strings.Join(tgt.hiddenVia, "', '") + "'"
			case tgt.status != "published":
				reason = "target not published (status: " + tgt.status + ")"
			default:
				continue // reachable — no issue
			}
			issues = append(issues, PostLinkIssue{
				SourceID:    r.ID,
				SourceSlug:  r.Slug,
				SourceTitle: r.Title,
				TargetSlug:  slug,
				Reason:      reason,
			})
		}
	}
	return issues, scanned, nil
}

// onPostsChanged is the single after-write hook for posts: every path that
// creates, edits, publishes, hides, schedules, trashes or restores a post ends
// here. It exists so the derived state that a post write invalidates is dropped
// in one place rather than being remembered at each of those call sites.
//
// Two things go stale on a post write:
//
//   - the tag counts and the in-memory tag graph built from them;
//   - the public page cache, which is what a guest (and the owner with revelio
//     off) is actually served. Without this, a post switched to hidden stayed
//     in the cached feed for the rest of the 15-minute TTL while opening it
//     already 404'd — the list and the post disagreeing about whether it exists.
func (s *PostService) onPostsChanged(ctx context.Context) {
	_ = s.repo.UpdateAllTagPostCounts(ctx)
	if s.tagService != nil {
		s.tagService.Invalidate()
	}
	if s.cache != nil {
		_ = s.cache.InvalidatePublicPages(ctx)
	}
}
