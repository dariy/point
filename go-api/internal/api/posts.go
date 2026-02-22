package api

import (
	"io"
	"math"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
)

type PostHandler struct {
	postService     *services.PostService
	settingsService *services.SettingsService
	mediaService    *services.MediaService
}

func NewPostHandler(postService *services.PostService, settingsService *services.SettingsService, mediaService *services.MediaService) *PostHandler {
	return &PostHandler{
		postService:     postService,
		settingsService: settingsService,
		mediaService:    mediaService,
	}
}

func buildPostResponse(post models.GetPostRow, tags []models.Tag, htmlContent string) map[string]interface{} {
	tagNames := make([]string, len(tags))
	for i, t := range tags {
		tagNames[i] = t.Name
	}
	return map[string]interface{}{
		"id":               post.ID,
		"title":            post.Title,
		"slug":             post.Slug,
		"content":          post.Content,
		"content_html":     htmlContent,
		"excerpt":          nullString(post.Excerpt),
		"status":           post.Status,
		"is_featured":      post.IsFeatured,
		"view_count":       post.ViewCount,
		"published_at":     nullTime(post.PublishedAt),
		"created_at":       post.CreatedAt,
		"updated_at":       post.UpdatedAt,
		"thumbnail_path":   nullString(post.ThumbnailPath),
		"meta_description": nullString(post.MetaDescription),
		"formatter":        post.Formatter,
		"tags":             tagNames,
		"author": map[string]interface{}{
			"id":           post.AuthorID,
			"username":     post.AuthorUsername,
			"display_name": post.AuthorDisplayName,
			"avatar_path":  nullString(post.AuthorAvatar),
		},
	}
}

func buildPostBySlugResponse(post models.GetPostBySlugRow, tags []models.Tag, htmlContent string) map[string]interface{} {
	tagNames := make([]string, len(tags))
	for i, t := range tags {
		tagNames[i] = t.Name
	}
	return map[string]interface{}{
		"id":               post.ID,
		"title":            post.Title,
		"slug":             post.Slug,
		"content":          post.Content,
		"content_html":     htmlContent,
		"excerpt":          nullString(post.Excerpt),
		"status":           post.Status,
		"is_featured":      post.IsFeatured,
		"view_count":       post.ViewCount,
		"published_at":     nullTime(post.PublishedAt),
		"created_at":       post.CreatedAt,
		"updated_at":       post.UpdatedAt,
		"thumbnail_path":   nullString(post.ThumbnailPath),
		"meta_description": nullString(post.MetaDescription),
		"formatter":        post.Formatter,
		"tags":             tagNames,
		"author": map[string]interface{}{
			"id":           post.AuthorID,
			"username":     post.AuthorUsername,
			"display_name": post.AuthorDisplayName,
			"avatar_path":  nullString(post.AuthorAvatar),
		},
	}
}

// getFullPostResponse fetches a post by ID with author and tags, returns the response map.
func (h *PostHandler) getFullPostResponse(c echo.Context, postID int64) (map[string]interface{}, error) {
	post, err := h.postService.GetPostByID(c.Request().Context(), postID)
	if err != nil {
		return nil, err
	}
	tags, _ := h.postService.GetTagsForPost(c.Request().Context(), postID)
	htmlContent, _ := h.postService.RenderContent(post.Content)
	return buildPostResponse(post, tags, htmlContent), nil
}

func (h *PostHandler) ListPosts(c echo.Context) error {
	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}

	perPage, _ := strconv.Atoi(c.QueryParam("per_page"))
	if perPage < 1 {
		perPageStr, _ := h.settingsService.GetSetting(c.Request().Context(), "posts_per_page", "10")
		perPage, _ = strconv.Atoi(perPageStr)
	}

	status := c.QueryParam("status")
	featured := c.QueryParam("featured") == "true"
	includeDrafts := c.Get("user") != nil

	posts, total, err := h.postService.ListPosts(c.Request().Context(), services.ListPostsParams{
		Page:          int32(page),
		PerPage:       int32(perPage),
		Status:        status,
		FeaturedOnly:  featured,
		IncludeDrafts: includeDrafts,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		postResponses[i] = postToResponse(p, nil)
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

	if post.Status == "draft" && c.Get("user") == nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

	if post.Status == "published" {
		_ = h.postService.IncrementViewCount(c.Request().Context(), post.ID)
	}

	htmlContent, _ := h.postService.RenderContent(post.Content)
	tags, _ := h.postService.GetTagsForPost(c.Request().Context(), post.ID)

	return c.JSON(http.StatusOK, buildPostBySlugResponse(post, tags, htmlContent))
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

	if post.Status == "draft" && c.Get("user") == nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

	htmlContent, _ := h.postService.RenderContent(post.Content)
	tags, _ := h.postService.GetTagsForPost(c.Request().Context(), post.ID)

	return c.JSON(http.StatusOK, buildPostResponse(post, tags, htmlContent))
}

type CreatePostRequest struct {
	Title           string   `json:"title"`
	Content         string   `json:"content"`
	Excerpt         string   `json:"excerpt"`
	Slug            string   `json:"slug"`
	Formatter       string   `json:"formatter"`
	Status          string   `json:"status"`
	IsFeatured      bool     `json:"is_featured"`
	ThumbnailPath   string   `json:"thumbnail_path"`
	MetaDescription string   `json:"meta_description"`
	Tags            []string `json:"tags"`
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
	if req.Formatter == "" {
		req.Formatter = "markdown"
	}

	post, err := h.postService.CreatePost(c.Request().Context(), services.CreatePostParams{
		Title:           req.Title,
		Content:         req.Content,
		Excerpt:         req.Excerpt,
		Slug:            req.Slug,
		Formatter:       req.Formatter,
		Status:          req.Status,
		IsFeatured:      req.IsFeatured,
		AuthorID:        authorID,
		ThumbnailPath:   req.ThumbnailPath,
		MetaDescription: req.MetaDescription,
		Tags:            req.Tags,
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

type UpdatePostRequest struct {
	Title           string   `json:"title"`
	Content         string   `json:"content"`
	Excerpt         string   `json:"excerpt"`
	Slug            string   `json:"slug"`
	Formatter       string   `json:"formatter"`
	Status          string   `json:"status"`
	IsFeatured      bool     `json:"is_featured"`
	ThumbnailPath   string   `json:"thumbnail_path"`
	MetaDescription string   `json:"meta_description"`
	Tags            []string `json:"tags"`
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

	_, err = h.postService.UpdatePost(c.Request().Context(), services.UpdatePostParams{
		ID:              id,
		AuthorID:        authorID,
		Title:           req.Title,
		Content:         req.Content,
		Excerpt:         req.Excerpt,
		Slug:            req.Slug,
		Formatter:       req.Formatter,
		Status:          req.Status,
		IsFeatured:      req.IsFeatured,
		ThumbnailPath:   req.ThumbnailPath,
		MetaDescription: req.MetaDescription,
		Tags:            req.Tags,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
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

	if err := h.postService.DeletePost(c.Request().Context(), id, authorID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
	}

	return c.NoContent(http.StatusNoContent)
}

func (h *PostHandler) PublishPost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	_, err = h.postService.PublishPost(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

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
	resp := buildPostResponse(post, tags, htmlContent)
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
	defer src.Close()

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
	post, err := h.postService.CreatePost(c.Request().Context(), services.CreatePostParams{
		Title:    title,
		Content:  "[audio:" + strconv.FormatInt(media.ID, 10) + "]",
		Slug:     "",
		Formatter: "markdown",
		Status:   "draft",
		AuthorID: authorID,
		Tags:     tags,
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

func (h *PostHandler) WithdrawPost(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	_, err = h.postService.WithdrawPost(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Post not found")
	}

	resp, err := h.getFullPostResponse(c, id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, resp)
}
