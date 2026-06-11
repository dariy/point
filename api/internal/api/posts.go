package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type PostHandler struct {
	postService     *services.PostService
	settingsService *services.SettingsService
	mediaService    *services.MediaService
	tagService      *services.TagService
}

func NewPostHandler(postService *services.PostService, settingsService *services.SettingsService, mediaService *services.MediaService, tagService *services.TagService) *PostHandler {
	return &PostHandler{
		postService:     postService,
		settingsService: settingsService,
		mediaService:    mediaService,
		tagService:      tagService,
	}
}

func buildPostResponse(post models.Post, tags []models.Tag, htmlContent string, excludeIDs map[int64]bool, media []models.Medium) map[string]interface{} {
	tagObjs := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		if excludeIDs != nil && excludeIDs[t.ID] {
			continue
		}
		tagObjs = append(tagObjs, map[string]interface{}{"name": t.Name, "slug": t.Slug})
	}

	mediaObjs := make([]map[string]interface{}, 0, len(media))
	for _, m := range media {
		var metadata map[string]interface{}
		if m.Metadata.Valid && m.Metadata.String != "" {
			_ = json.Unmarshal([]byte(m.Metadata.String), &metadata)
		}
		mediaObjs = append(mediaObjs, map[string]interface{}{
			"path":     "/" + strings.TrimPrefix(m.OriginalPath, "originals/"),
			"alt_text": nullString(m.AltText),
			"metadata": metadata,
		})
	}

	return map[string]interface{}{
		"id":               post.ID,
		"title":            post.Title,
		"slug":             post.Slug,
		"type":             post.Type,
		"content":          post.Content,
		"content_html":     htmlContent,
		"css":              post.Css,
		"immersive_mode":   post.ImmersiveMode,
		"excerpt":          nullString(post.Excerpt),
		"status":           post.Status,
		"is_featured":      post.IsFeatured,
		"view_count":       post.ViewCount,
		"published_at":     nullTime(post.PublishedAt),
		"scheduled_at":     nullTime(post.ScheduledAt),
		"created_at":       post.CreatedAt,
		"updated_at":       post.UpdatedAt,
		"thumbnail_path":   nullString(post.ThumbnailPath),
		"meta_description": nullString(post.MetaDescription),
		"formatter":        post.Formatter,
		"tags":             tagObjs,
		"media":            mediaObjs,
	}
}

func (h *PostHandler) fetchPostMedia(ctx context.Context, post models.Post) []models.Medium {
	if h.mediaService == nil {
		return nil
	}
	media, _ := h.mediaService.GetMediaByContent(ctx, post.Content, post.ThumbnailPath.String)
	return media
}

// getFullPostResponse fetches a post by ID with author and tags, returns the response map.
// Always injects hidden fields since this is called only from auth-required handlers.
func (h *PostHandler) getFullPostResponse(c echo.Context, postID int64) (map[string]interface{}, error) {
	ctx := c.Request().Context()
	post, err := h.postService.GetPostByID(ctx, postID)
	if err != nil {
		return nil, err
	}
	tags, _ := h.postService.GetTagsForPost(ctx, postID)
	htmlContent, _ := h.postService.RenderContent(post.Content)

	isAdmin := c.Get("user") != nil
	snap, _ := h.tagService.GetTagSnapshot(ctx)
	var excludeTagIDs map[int64]bool
	if !isAdmin && snap != nil {
		minPostsStr, _ := h.settingsService.GetSetting(ctx, "min_tag_posts_to_show", "0")
		minPosts, _ := strconv.ParseInt(minPostsStr, 10, 64)
		excludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
	}
	// Admin sees all tags (including hidden/year tags) for accurate editing

	postMedia := h.fetchPostMedia(ctx, post)
	resp := buildPostResponse(post, tags, htmlContent, excludeTagIDs, postMedia)
	var effectiveHiddenPosts map[int64]bool
	if snap != nil {
		effectiveHiddenPosts = snap.EffectiveHidesPosts
	}
	injectPostHiddenFields(resp, post.Status, tags, effectiveHiddenPosts)
	injectPostInstagramFields(resp, post)
	return resp, nil
}

func (h *PostHandler) ListPosts(c echo.Context) error {
	pageParsed, _ := strconv.ParseInt(c.QueryParam("page"), 10, 32)
	page := int32(pageParsed)
	if page < 1 {
		page = 1
	}

	perPage := 0
	if parsedPerPage, err := strconv.ParseInt(c.QueryParam("per_page"), 10, 32); err == nil {
		perPage = int(parsedPerPage)
	}
	if perPage < 1 {
		perPageStr, _ := h.settingsService.GetSetting(c.Request().Context(), "posts_per_page", "10")
		if parsedPerPage, err := strconv.ParseInt(perPageStr, 10, 32); err == nil {
			perPage = int(parsedPerPage)
		}
	}

	status := c.QueryParam("status")
	featured := c.QueryParam("featured") == "true"
	includeDrafts := c.Get("user") != nil
	search := c.QueryParam("q")

	// Trash view: only admins can see trash.
	if status == "trash" && c.Get("user") != nil {
		posts, total, err := h.postService.ListTrashedPosts(c.Request().Context(), page, int32(perPage))
		if err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
		postResponses := make([]map[string]interface{}, len(posts))
		for i, p := range posts {
			resp := postToResponse(p, nil, nil)
			resp["deleted_at"] = p.DeletedAt
			postResponses[i] = resp
		}
		pages := int(math.Ceil(float64(total) / float64(perPage)))
		if pages == 0 {
			pages = 1
		}
		return c.JSON(http.StatusOK, map[string]interface{}{
			"posts":    postResponses,
			"total":    total,
			"page":     page,
			"per_page": perPage,
			"pages":    pages,
		})
	}

	posts, total, err := h.postService.ListPosts(c.Request().Context(), services.ListPostsParams{
		Page:          page,
		PerPage:       int32(perPage),
		Status:        status,
		FeaturedOnly:  featured,
		IncludeDrafts: includeDrafts,
		Search:        search,
		SortBy:        c.QueryParam("sort"),
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	postIDs := make([]int64, len(posts))
	for i, p := range posts {
		postIDs[i] = p.ID
	}
	postTagsMap, _ := h.postService.GetTagsByPostIDs(c.Request().Context(), postIDs)

	isAdmin := c.Get("user") != nil
	snap, _ := h.tagService.GetTagSnapshot(c.Request().Context())
	var effectiveHiddenPosts map[int64]bool
	var excludeTagIDs map[int64]bool

	if snap != nil {
		if isAdmin {
			effectiveHiddenPosts = snap.EffectiveHidesPosts
		} else {
			minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
			minPosts, _ := strconv.ParseInt(minPostsStr, 10, 64)
			excludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
		}
	}
	// Admin sees all tags (including hidden/year tags) for accurate editing

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		resp := postToResponse(p, postTagsMap[p.ID], excludeTagIDs)
		if isAdmin {
			injectPostHiddenFieldsFromInfo(resp, p.Status, postTagsMap[p.ID], effectiveHiddenPosts)
		}
		postResponses[i] = resp
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"posts":    postResponses,
		"total":    total,
		"page":     page,
		"per_page": perPage,
		"pages":    pages,
	})
}

func (h *PostHandler) GetPostBySlug(c echo.Context) error {
	slug := c.Param("slug")
	post, err := h.postService.GetPostBySlug(c.Request().Context(), slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

	ctx := c.Request().Context()
	tags, _ := h.postService.GetTagsForPost(ctx, post.ID)

	snap, _ := h.tagService.GetTagSnapshot(ctx)
	var effectiveHiddenPosts map[int64]bool
	if snap != nil {
		effectiveHiddenPosts = snap.EffectiveHidesPosts
	}
	isAdmin := c.Get("user") != nil
	if !isAdmin {
		if strings.EqualFold(post.Status, "draft") || strings.EqualFold(post.Status, "hidden") {
			return echo.NewHTTPError(http.StatusNotFound, "Post not found")
		}
		for _, t := range tags {
			if effectiveHiddenPosts != nil && effectiveHiddenPosts[t.ID] {
				return echo.NewHTTPError(http.StatusNotFound, "Post not found")
			}
		}
	}

	if !isAdmin && strings.EqualFold(post.Status, "published") {
		_ = h.postService.IncrementViewCount(ctx, post.ID)
	}

	var excludeTagIDs map[int64]bool
	if !isAdmin && snap != nil {
		minPostsStr, _ := h.settingsService.GetSetting(ctx, "min_tag_posts_to_show", "0")
		minPosts, _ := strconv.ParseInt(minPostsStr, 10, 64)
		excludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
	}
	// Admin sees all tags (including hidden/year tags) for accurate editing

	htmlContent, _ := h.postService.RenderContent(post.Content)
	postMedia := h.fetchPostMedia(ctx, post)
	resp := buildPostResponse(post, tags, htmlContent, excludeTagIDs, postMedia)
	if isAdmin {
		injectPostHiddenFields(resp, post.Status, tags, effectiveHiddenPosts)
		injectPostInstagramFields(resp, post)
	} else {
		showViewCountsStr, _ := h.settingsService.GetSetting(ctx, "show_view_counts", "false")
		if showViewCountsStr != "true" {
			delete(resp, "view_count")
		}
	}
	return c.JSON(http.StatusOK, resp)
}

// GetPostPage returns the home-feed (or tag-feed) page number that contains the given post slug.
// GET /api/posts/:slug/page?tag=some-tag
func (h *PostHandler) GetPostPage(c echo.Context) error {
	ctx := c.Request().Context()
	slug := c.Param("slug")
	tagFilter := c.QueryParam("tag")
	user := c.Get("user")
	publicOnly := user == nil

	// Verify the post exists and is published
	post, err := h.postService.GetPostBySlug(ctx, slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "post not found")
	}

	// Compute effective hidden-posts tag set
	snap, _ := h.tagService.GetTagSnapshot(ctx)
	var hiddenTagIDs map[int64]bool
	if snap != nil {
		hiddenTagIDs = snap.EffectiveHidesPosts
	}

	// Fetch all published post stubs (lightweight: id, slug, published_at)
	stubs, err := h.postService.ListPublishedPostStubs(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to list posts")
	}

	// Bulk-fetch tags for all stub IDs
	ids := make([]int64, len(stubs))
	for i, s := range stubs {
		ids[i] = s.ID
	}
	tagsMap, _ := h.postService.GetTagsByPostIDs(ctx, ids)

	// Walk stubs in order (newest first), apply filters, find position
	position := 0
	found := false

	var filterTagIDs map[int64]bool
	if tagFilter != "" && snap != nil {
		if t, ok := snap.BySlug[strings.ToLower(tagFilter)]; ok {
			filterTagIDs = make(map[int64]bool)
			filterTagIDs[t.ID] = true
			descIDs := snap.GetDescendantIDs(t.ID)
			for _, dID := range descIDs {
				filterTagIDs[dID] = true
			}
		}
	}

	for _, s := range stubs {
		// Public visibility check
		if publicOnly && !IsPostVisibleToPublic(tagsMap[s.ID], hiddenTagIDs) {
			continue
		}

		// Tag filter check
		if tagFilter != "" {
			hasTag := false
			for _, t := range tagsMap[s.ID] {
				if filterTagIDs[t.ID] {
					hasTag = true
					break
				}
			}
			if !hasTag {
				continue
			}
		}

		position++
		if s.Slug == post.Slug {
			found = true
			break
		}
	}
	if !found {
		return echo.NewHTTPError(http.StatusNotFound, "post not found")
	}

	perPageStr, _ := h.settingsService.GetSetting(ctx, "posts_per_page", "10")
	perPage, _ := strconv.Atoi(perPageStr)
	if perPage < 1 {
		perPage = 10
	}

	page := int(math.Ceil(float64(position) / float64(perPage)))
	return c.JSON(http.StatusOK, map[string]interface{}{
		"page":     page,
		"per_page": perPage,
	})
}

func (h *PostHandler) GetPostByID(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	post, err := h.postService.GetPostByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

	ctx := c.Request().Context()
	tags, _ := h.postService.GetTagsForPost(ctx, post.ID)

	snap, _ := h.tagService.GetTagSnapshot(ctx)
	var effectiveHiddenPosts map[int64]bool
	if snap != nil {
		effectiveHiddenPosts = snap.EffectiveHidesPosts
	}
	isAdmin := c.Get("user") != nil
	if !isAdmin {
		if strings.EqualFold(post.Status, "draft") || strings.EqualFold(post.Status, "hidden") {
			return echo.NewHTTPError(http.StatusNotFound, "Post not found")
		}
		for _, t := range tags {
			if effectiveHiddenPosts != nil && effectiveHiddenPosts[t.ID] {
				return echo.NewHTTPError(http.StatusNotFound, "Post not found")
			}
		}
	}

	var excludeTagIDs map[int64]bool
	if !isAdmin && snap != nil {
		minPostsStr, _ := h.settingsService.GetSetting(ctx, "min_tag_posts_to_show", "0")
		minPosts, _ := strconv.ParseInt(minPostsStr, 10, 64)
		excludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
	}
	// Admin sees all tags (including hidden/year tags) for accurate editing

	htmlContent, _ := h.postService.RenderContent(post.Content)
	postMedia := h.fetchPostMedia(ctx, post)
	resp := buildPostResponse(post, tags, htmlContent, excludeTagIDs, postMedia)
	if isAdmin {
		injectPostHiddenFields(resp, post.Status, tags, effectiveHiddenPosts)
		injectPostInstagramFields(resp, post)
	}

	return c.JSON(http.StatusOK, resp)
}

type CreatePostRequest struct {
	Title           string   `json:"title"`
	Content         string   `json:"content"`
	CSS             string   `json:"css"`
	ImmersiveMode   string   `json:"immersive_mode"`
	InstagramShare  bool     `json:"instagram_share"`
	Excerpt         string   `json:"excerpt"`
	Slug            string   `json:"slug"`
	Formatter       string   `json:"formatter"`
	Status          string   `json:"status"`
	Type            string   `json:"type"`
	IsFeatured      bool     `json:"is_featured"`
	ThumbnailPath   string   `json:"thumbnail_path"`
	MetaDescription string   `json:"meta_description"`
	Tags            []string `json:"tags"`
	ScheduledAt     *string  `json:"scheduled_at"`
}

func parseScheduledAt(s *string) (*time.Time, error) {
	if s == nil || *s == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, *s)
	if err != nil {
		return nil, fmt.Errorf("invalid scheduled_at: must be RFC3339 (e.g. 2026-04-17T15:04:05Z)")
	}
	return &t, nil
}

func (h *PostHandler) CreatePost(c echo.Context) error {
	authorID := extractUserID(c.Get("user"))

	var req CreatePostRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if req.Status == "" {
		req.Status = "draft"
	}
	if req.Type == "" && req.Status == "page" {
		req.Type = "page"
		req.Status = "published"
	}
	if req.Formatter == "" {
		req.Formatter = "markdown"
	}

	scheduledAt, err := parseScheduledAt(req.ScheduledAt)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
	}
	if scheduledAt != nil && time.Now().Before(*scheduledAt) {
		req.Status = "scheduled"
	} else if scheduledAt != nil {
		// past scheduled_at: publish immediately, don't store the schedule time
		req.Status = "published"
		scheduledAt = nil
	}

	post, cssWarnings, err := h.postService.CreatePost(c.Request().Context(), services.CreatePostParams{
		Title:           req.Title,
		Content:         req.Content,
		CSS:             req.CSS,
		ImmersiveMode:   req.ImmersiveMode,
		InstagramShare:  req.InstagramShare,
		Excerpt:         req.Excerpt,
		Slug:            req.Slug,
		Formatter:       req.Formatter,
		Status:          req.Status,
		Type:            req.Type,
		IsFeatured:      req.IsFeatured,
		AuthorID:        authorID,
		ThumbnailPath:   req.ThumbnailPath,
		MetaDescription: req.MetaDescription,
		Tags:            req.Tags,
		ScheduledAt:     scheduledAt,
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: posts.slug") {
			return c.JSON(http.StatusConflict, map[string]string{"detail": "A post with this slug already exists. Please choose a different title or slug."})
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	if strings.EqualFold(post.Status, "published") {
		paths := services.ExtractMediaPaths(post.Content, post.ThumbnailPath.String)
		_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), paths)
	}

	resp, err := h.getFullPostResponse(c, post.ID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if len(cssWarnings) > 0 {
		resp["css_warnings"] = cssWarnings
	}

	return c.JSON(http.StatusCreated, resp)
}

type UpdatePostRequest struct {
	Title           string   `json:"title"`
	Content         string   `json:"content"`
	CSS             string   `json:"css"`
	ImmersiveMode   string   `json:"immersive_mode"`
	InstagramShare  bool     `json:"instagram_share"`
	Excerpt         string   `json:"excerpt"`
	Slug            string   `json:"slug"`
	Formatter       string   `json:"formatter"`
	Status          string   `json:"status"`
	Type            string   `json:"type"`
	IsFeatured      bool     `json:"is_featured"`
	ThumbnailPath   string   `json:"thumbnail_path"`
	MetaDescription string   `json:"meta_description"`
	Tags            []string `json:"tags"`
	ScheduledAt     *string  `json:"scheduled_at"`
}

func (h *PostHandler) UpdatePost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	authorID := extractUserID(c.Get("user"))

	var req UpdatePostRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	scheduledAt, err := parseScheduledAt(req.ScheduledAt)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
	}

	// Load old post for merging and media path tracking
	old, err := h.postService.GetPostByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	// Capture pre-update paths so that images removed from the post are also re-evaluated.
	oldPaths := services.ExtractMediaPaths(old.Content, old.ThumbnailPath.String)

	// Merge fields if they are empty in the request (pragmatic partial PUT support)
	if req.Title == "" {
		req.Title = old.Title
	}
	if req.Content == "" {
		req.Content = old.Content
	}
	if req.Slug == "" {
		req.Slug = old.Slug
	}
	if req.Formatter == "" {
		req.Formatter = old.Formatter
	}
	if req.Status == "" {
		req.Status = old.Status
	}
	if req.Type == "" && req.Status == "page" {
		req.Type = "page"
		req.Status = "published"
	}
	if req.Type == "" {
		req.Type = old.Type
	}

	if scheduledAt != nil && time.Now().Before(*scheduledAt) {
		req.Status = "scheduled"
	} else if scheduledAt != nil {
		req.Status = "published"
		scheduledAt = nil
	}

	updated, cssWarnings, err := h.postService.UpdatePost(c.Request().Context(), services.UpdatePostParams{
		ID:              id,
		AuthorID:        authorID,
		Title:           req.Title,
		Content:         req.Content,
		CSS:             req.CSS,
		ImmersiveMode:   req.ImmersiveMode,
		InstagramShare:  req.InstagramShare,
		Excerpt:         req.Excerpt,
		Slug:            req.Slug,
		Formatter:       req.Formatter,
		Status:          req.Status,
		Type:            req.Type,
		IsFeatured:      req.IsFeatured,
		ThumbnailPath:   req.ThumbnailPath,
		MetaDescription: req.MetaDescription,
		Tags:            req.Tags,
		ScheduledAt:     scheduledAt,
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: posts.slug") {
			return c.JSON(http.StatusConflict, map[string]string{"detail": "A post with this slug already exists. Please choose a different slug."})
		}
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	newPaths := services.ExtractMediaPaths(updated.Content, updated.ThumbnailPath.String)
	_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), append(oldPaths, newPaths...))

	resp, err := h.getFullPostResponse(c, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if len(cssWarnings) > 0 {
		resp["css_warnings"] = cssWarnings
	}

	return c.JSON(http.StatusOK, resp)
}

func (h *PostHandler) UpdatePostStatus(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	var req struct {
		Status string `json:"status"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if req.Status == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "status is required")
	}

	updated, err := h.postService.UpdatePostStatus(c.Request().Context(), id, req.Status)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	// Status changes affect media visibility (e.g. going from draft to published)
	paths := services.ExtractMediaPaths(updated.Content, updated.ThumbnailPath.String)
	_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), paths)

	resp, err := h.getFullPostResponse(c, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, resp)
}

func (h *PostHandler) UpdatePostTags(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	var req struct {
		Tags []string `json:"tags"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if err := h.postService.UpdatePostTags(c.Request().Context(), id, req.Tags); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	// Tag changes may affect hidden_posts inheritance — refresh visibility.
	if post, err := h.postService.GetPostByID(c.Request().Context(), id); err == nil {
		paths := services.ExtractMediaPaths(post.Content, post.ThumbnailPath.String)
		_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), paths)
	}

	resp, err := h.getFullPostResponse(c, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, resp)
}

func (h *PostHandler) DeletePost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	authorID := extractUserID(c.Get("user"))

	var mediaPaths []string
	if post, err := h.postService.GetPostByID(c.Request().Context(), id); err == nil {
		mediaPaths = services.ExtractMediaPaths(post.Content, post.ThumbnailPath.String)
	}

	if err := h.postService.SoftDeletePost(c.Request().Context(), id, authorID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), mediaPaths)

	return c.NoContent(http.StatusNoContent)
}

func (h *PostHandler) RestorePost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	authorID := extractUserID(c.Get("user"))

	if err := h.postService.RestorePost(c.Request().Context(), id, authorID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	// Recalculate media visibility after restore.
	if post, err := h.postService.GetPostByID(c.Request().Context(), id); err == nil {
		mediaPaths := services.ExtractMediaPaths(post.Content, post.ThumbnailPath.String)
		_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), mediaPaths)
	}

	return c.NoContent(http.StatusNoContent)
}

func (h *PostHandler) PermanentlyDeletePost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	authorID := extractUserID(c.Get("user"))

	// Fetch the trashed post to get media paths (GetPostByID excludes deleted, so query directly).
	if err := h.postService.PermanentlyDeletePost(c.Request().Context(), id, authorID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	return c.NoContent(http.StatusNoContent)
}

func (h *PostHandler) PublishPost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	published, err := h.postService.PublishPost(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

	paths := services.ExtractMediaPaths(published.Content, published.ThumbnailPath.String)
	_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), paths)

	resp, err := h.getFullPostResponse(c, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, resp)
}

func (h *PostHandler) GeneratePreviewLink(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	token, expiresAt, err := h.postService.GeneratePreviewLink(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "post not found")
	}

	base := c.Scheme() + "://" + c.Request().Host
	if fwd := c.Request().Header.Get("X-Forwarded-Proto"); fwd != "" {
		base = fwd + "://" + c.Request().Host
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"preview_url": base + "/preview/" + token,
		"token":       token,
		"expires_at":  expiresAt,
	})
}

func (h *PostHandler) GetPostByPreviewToken(c echo.Context) error {
	token := c.Param("token")
	if token == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "token required")
	}

	post, err := h.postService.GetPostByPreviewToken(c.Request().Context(), token)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "invalid or expired preview link")
	}

	tags, _ := h.postService.GetTagsForPost(c.Request().Context(), post.ID)
	htmlContent, _ := h.postService.RenderContent(post.Content)
	postMedia := h.fetchPostMedia(c.Request().Context(), post)
	resp := buildPostResponse(post, tags, htmlContent, nil, postMedia)
	resp["preview_mode"] = true

	return c.JSON(http.StatusOK, resp)
}

// CreateAudioPost uploads an audio file and creates a draft post linked to it.
func (h *PostHandler) CreateAudioPost(c echo.Context) error {
	authorID := extractUserID(c.Get("user"))

	file, err := c.FormFile("file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "file is required")
	}

	title := c.FormValue("title")
	if title == "" {
		// Use filename without extension as title
		title = strings.TrimSuffix(file.Filename, filepath.Ext(file.Filename))
	}

	tagsStr := c.FormValue("tags")
	var tags []string
	if tagsStr != "" {
		for _, t := range strings.Split(tagsStr, ",") {
			t = strings.TrimSpace(t)
			if t != "" {
				tags = append(tags, t)
			}
		}
	}

	// Read file content
	src, err := file.Open()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to open file")
	}
	defer func() {
		_ = src.Close()
	}()

	content, err := io.ReadAll(src)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to read file")
	}

	// Upload the audio media
	media, err := h.mediaService.UploadFile(c.Request().Context(), services.UploadFileParams{
		Content:  content,
		Filename: file.Filename,
		MimeType: file.Header.Get("Content-Type"),
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Create the post with embedded audio reference
	post, _, err := h.postService.CreatePost(c.Request().Context(), services.CreatePostParams{
		Title:     title,
		Content:   "[audio:" + strconv.FormatInt(media.ID, 10) + "]",
		Slug:      "",
		Formatter: "markdown",
		Status:    "draft",
		Type:      "audio",
		AuthorID:  authorID,
		Tags:      tags,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	resp, err := h.getFullPostResponse(c, post.ID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusCreated, resp)
}

func (h *PostHandler) GetPostNavigation(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	publicOnly := c.Get("user") == nil
	prev, next, err := h.postService.GetPostNavigation(c.Request().Context(), id, publicOnly)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "post not found")
	}

	resp := map[string]interface{}{"prev": nil, "next": nil}
	if prev != nil {
		resp["prev"] = map[string]interface{}{"id": prev.ID, "title": prev.Title, "slug": prev.Slug}
	}
	if next != nil {
		resp["next"] = map[string]interface{}{"id": next.ID, "title": next.Title, "slug": next.Slug}
	}
	return c.JSON(http.StatusOK, resp)
}

func (h *PostHandler) WithdrawPost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	withdrawn, err := h.postService.WithdrawPost(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

	paths := services.ExtractMediaPaths(withdrawn.Content, withdrawn.ThumbnailPath.String)
	_ = h.mediaService.UpdateMediaVisibilityForPaths(c.Request().Context(), paths)

	resp, err := h.getFullPostResponse(c, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, resp)
}

func (h *PostHandler) GetPostAnalytics(c echo.Context) error {
	stats, err := h.postService.GetPostAnalytics(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"total_views":            stats.TotalViews,
		"average_views_per_post": stats.AverageViews,
		"most_viewed_post_id":    stats.MostViewedPostID,
	})
}

// PublishToInstagram manually triggers cross-posting to Instagram for a post.
// POST /api/posts/:id/instagram/publish
func (h *PostHandler) PublishToInstagram(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	ctx := c.Request().Context()
	ctx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()

	// CrossPostToInstagram handles status updates in the database.
	_ = h.postService.CrossPostToInstagram(ctx, id)

	resp, err := h.getFullPostResponse(c, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, resp)
}
