package api

import (
	"math"
	"net/http"
	"strconv"

	"github.com/labstack/echo/v4"
	"point-api/internal/repository"
	"point-api/internal/services"
)

type PagesHandler struct {
	repo            *repository.Repository
	postService     *services.PostService
	tagService      *services.TagService
	settingsService *services.SettingsService
}

func NewPagesHandler(repo *repository.Repository, postService *services.PostService, tagService *services.TagService, settingsService *services.SettingsService) *PagesHandler {
	return &PagesHandler{
		repo:            repo,
		postService:     postService,
		tagService:      tagService,
		settingsService: settingsService,
	}
}

var pagePublicSettingKeys = map[string]bool{
	"blog_title":       true,
	"blog_subtitle":    true,
	"author_name":      true,
	"posts_per_page":   true,
	"default_theme":    true,
	"show_view_counts": true,
	"use_thumbnails":   true,
	"about_post_id":    true,
}

// GetHomePage returns all data needed to render the public homepage.
func (h *PagesHandler) GetHomePage(c echo.Context) error {
	ctx := c.Request().Context()

	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}

	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	perPageStr := getSettingOr(allSettings, "posts_per_page", "10")
	perPage, _ := strconv.Atoi(perPageStr)
	if perPage < 1 {
		perPage = 10
	}
	if qpp, _ := strconv.Atoi(c.QueryParam("per_page")); qpp > 0 {
		perPage = qpp
	}

	// Published posts
	posts, total, err := h.postService.ListPosts(ctx, services.ListPostsParams{
		Page:          int32(page),
		PerPage:       int32(perPage),
		IncludeDrafts: false,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		postResponses[i] = postToResponse(p)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	// Tag cloud (non-empty tags)
	cloud, _ := h.tagService.GetTagCloud(ctx, 20)

	// Top-level tags for nav (non-hidden, non-empty)
	allTags, _ := h.tagService.ListTags(ctx, false, false)
	navTags := make([]map[string]interface{}, 0)
	for _, t := range allTags {
		if !t.IsHidden {
			navTags = append(navTags, tagToListItem(t))
		}
	}

	// Public settings subset
	publicSettings := make(map[string]string)
	for k, v := range allSettings {
		if pagePublicSettingKeys[k] {
			publicSettings[k] = v
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"posts": postResponses,
		"pagination": map[string]interface{}{
			"page":     page,
			"per_page": perPage,
			"total":    total,
			"pages":    pages,
		},
		"tag_cloud": cloud,
		"nav_tags":  navTags,
		"settings":  publicSettings,
	})
}

// GetTagPage returns all data needed to render a tag archive page.
func (h *PagesHandler) GetTagPage(c echo.Context) error {
	ctx := c.Request().Context()
	slug := c.Param("slug")

	tag, err := h.tagService.GetTagBySlug(ctx, slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}

	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	perPageStr := getSettingOr(allSettings, "posts_per_page", "10")
	perPage, _ := strconv.Atoi(perPageStr)
	if perPage < 1 {
		perPage = 10
	}
	if qpp, _ := strconv.Atoi(c.QueryParam("per_page")); qpp > 0 {
		perPage = qpp
	}

	// Breadcrumb ancestors
	ancestors, _ := h.repo.GetTagAncestors(ctx, tag.ID)

	// Direct children for sub-nav
	children, _ := h.tagService.GetTagChildren(ctx, tag.ID)
	childItems := make([]map[string]interface{}, 0, len(children))
	for _, ch := range children {
		if !ch.IsHidden {
			childItems = append(childItems, tagToListItem(ch))
		}
	}

	// Posts for this tag (published only)
	posts, total, err := h.tagService.GetPostsByTag(ctx, tag.ID, int32(page), int32(perPage), true)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		postResponses[i] = postByTagToResponse(p)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	breadcrumbs := make([]map[string]interface{}, len(ancestors))
	for i, a := range ancestors {
		breadcrumbs[i] = tagToListItem(a)
	}

	parents, _ := h.tagService.GetTagParents(ctx, tag.ID)
	return c.JSON(http.StatusOK, map[string]interface{}{
		"tag":         tagToFullResponse(tag, parents, children),
		"breadcrumbs": breadcrumbs,
		"posts":       postResponses,
		"pagination": map[string]interface{}{
			"page":     page,
			"per_page": perPage,
			"total":    total,
			"pages":    pages,
		},
		"nav_tags": childItems,
	})
}

// GetTagsPage returns data for the tags directory page.
func (h *PagesHandler) GetTagsPage(c echo.Context) error {
	ctx := c.Request().Context()

	tags, err := h.tagService.ListTags(ctx, false, false)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Filter hidden tags for public view
	visible := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		if !t.IsHidden {
			parents, _ := h.tagService.GetTagParents(ctx, t.ID)
			children, _ := h.tagService.GetTagChildren(ctx, t.ID)
			visible = append(visible, tagToFullResponse(t, parents, children))
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"tags":  visible,
		"total": len(visible),
	})
}
