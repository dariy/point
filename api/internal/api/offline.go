package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"point-api/internal/models"
	"point-api/internal/services"
	"point-api/internal/services/pageview"

	"github.com/labstack/echo/v4"
)

// GetOfflineStats returns counts and sizes of posts and media for offline caching.
// GET /api/offline/stats
func (h *SystemHandler) GetOfflineStats(c echo.Context) error {
	ctx := c.Request().Context()

	stats, err := h.repo.GetSystemStats(ctx)
	if err != nil {
		return MapError(err)
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
			// Size the offline budget off the rung the service worker caches,
			// not the poster column: an image's derived sizes live in the
			// variants tree and thumbnail_path is a video's poster frame.
			variant := filepath.Join(h.dataPath, "media", services.VariantRelPath(m.OriginalPath, services.DefaultVariantSize))
			if info, err := os.Stat(variant); err == nil {
				thumbBytes += info.Size()
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
		Limit:          10000,
		Offset:         0,
		IncludeHidden:  true, // Includes 'published' and 'hidden'
		IncludeDrafts:  false,
		IncludeContent: true, // Offline reading needs the full body, not just media_url
	})
	if err != nil {
		return MapError(err)
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

	// Every media row on the site, read once. The snapshot bundles every post
	// body, so the per-post lookup GetMediaByContent does would be a query per
	// post; the public media list below needs the same rows anyway.
	allMedia, _ := h.repo.GetAllMediaPaths(ctx)
	gen := h.mediaService.ThumbnailGeneration(ctx)
	mediaDims := articleImageDims(allMedia)

	// Convert to response format
	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		html, _ := h.postService.RenderContent(p.Content)
		// An offline reader is the one that benefits most from a small
		// variant: it is on the connection that made them cache the site.
		html = injectArticleSrcsetDims(html, mediaDims, gen)
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
			"media_url":        pageview.ExtractMediaURL(p.ThumbnailPath, p.Content),
		}
		postResponses[i] = resp
	}

	// 2. All tags
	tags, err := h.tagService.ListTags(ctx, false, true)
	if err != nil {
		return MapError(err)
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
	publicMedia := make([]map[string]interface{}, 0)
	for _, m := range allMedia {
		if strings.ToLower(m.FileType) == "image" && m.IsPublic == 1 {
			publicMedia = append(publicMedia, mediaToResponse(m, gen))
		}
	}

	// 6. Blog settings — only public-safe keys for client-side storage
	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	publicSettings := pageview.PublicSettings(allSettings)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"posts":             postResponses,
		"tags":              tags,
		"tag_relationships": relationships,
		"tag_locations":     locations,
		"media":             publicMedia,
		"settings":          publicSettings,
		"exported_at":       time.Now().UTC().Round(0),
	})
}
