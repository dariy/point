package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
)

// GetOfflineStats returns counts and sizes of posts and media for offline caching.
// GET /api/offline/stats
func (h *SystemHandler) GetOfflineStats(c echo.Context) error {
	ctx := c.Request().Context()

	stats, err := h.repo.GetSystemStats(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Calculate image sizes by walking the storage path
	var thumbBytes, originalBytes int64
	var imageCount int64

	media, err := h.repo.GetAllMediaPaths(ctx)
	if err == nil {
		for _, m := range media {
			if strings.ToLower(m.FileType) != "image" || m.IsPublic == 0 {
				continue
			}
			imageCount++
			originalBytes += m.FileSize
			if m.ThumbnailPath.Valid {
				thumbFile := filepath.Join(h.dataPath, "media", m.ThumbnailPath.String)
				if info, err := os.Stat(thumbFile); err == nil {
					thumbBytes += info.Size()
				}
			}
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"post_count":      stats.PublishedCount,
		"image_count":     imageCount,
		"thumbnail_bytes": thumbBytes,
		"original_bytes":  originalBytes,
	})
}

// GetOfflineSnapshot returns all data needed for public offline reading.
// GET /api/offline/snapshot
func (h *SystemHandler) GetOfflineSnapshot(c echo.Context) error {
	ctx := c.Request().Context()

	// 1. All published posts and pages
	allPosts, err := h.repo.ListPosts(ctx, models.ListPostsParams{
		Limit:         10000,
		Offset:        0,
		IncludeHidden: true, // Includes 'published' and 'hidden'
		IncludeDrafts: false,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Filter to include 'published', 'hidden', and 'page'
	posts := make([]models.Post, 0)
	for _, p := range allPosts {
		st := strings.ToLower(p.Status)
		if st == "published" || st == "hidden" || st == "page" {
			posts = append(posts, p)
		}
	}

	postIDs := make([]int64, len(posts))
	for i, p := range posts {
		postIDs[i] = p.ID
	}
	postTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, postIDs)

	// Convert to response format
	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		html, _ := h.postService.RenderContent(p.Content)
		// Use a temporary map to build a response that looks like GetPostRow/GetPostBySlugRow
		resp := map[string]interface{}{
			"id":               p.ID,
			"title":            p.Title,
			"slug":             p.Slug,
			"content":          p.Content,
			"content_html":     html,
			"excerpt":          nullString(p.Excerpt),
			"status":           p.Status,
			"is_featured":      p.IsFeatured,
			"view_count":       p.ViewCount,
			"published_at":     nullTime(p.PublishedAt),
			"created_at":       p.CreatedAt,
			"updated_at":       p.UpdatedAt,
			"thumbnail_path":   nullString(p.ThumbnailPath),
			"meta_description": nullString(p.MetaDescription),
			"formatter":        p.Formatter,
			"tags":             postTagsMap[p.ID],
			"media_url": extractMediaURL(p.ThumbnailPath, p.Content),
		}
		postResponses[i] = resp
	}

	// 2. All tags
	tags, err := h.tagService.ListTags(ctx, false, true)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// 3. Tag relationships
	relationships, _ := h.repo.GetAllTagRelationships(ctx)

	// 4. Tag locations
	tagIDs := make([]int64, len(tags))
	for i, t := range tags {
		tagIDs[i] = t.ID
	}
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, tagIDs)
	locations := make([]models.TagLocation, 0, len(locMap))
	for _, l := range locMap {
		locations = append(locations, l)
	}

	// 5. Public media (images only)
	media, _ := h.repo.GetAllMediaPaths(ctx)
	publicMedia := make([]map[string]interface{}, 0)
	for _, m := range media {
		if strings.ToLower(m.FileType) == "image" && m.IsPublic == 1 {
			publicMedia = append(publicMedia, mediaToResponse(m))
		}
	}

	// 6. Blog settings
	settings, _ := h.settingsService.GetAllSettings(ctx)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"posts":             postResponses,
		"tags":              tags,
		"tag_relationships": relationships,
		"tag_locations":     locations,
		"media":             publicMedia,
		"settings":          settings,
		"exported_at":       time.Now().UTC().Round(0),
	})
}
