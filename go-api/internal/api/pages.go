package api

import (
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
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

	postIDs := make([]int64, len(posts))
	for i, p := range posts {
		postIDs[i] = p.ID
	}
	postTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, postIDs)

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		postResponses[i] = postToResponse(p, postTagsMap[p.ID])
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	// Tag cloud (non-empty tags)
	cloud, _ := h.tagService.GetTagCloud(ctx, 20)

	// Hierarchical tags for nav (root tags with nested children)
	navTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil)

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

	effectivelyHidden, _ := h.tagService.EffectivelyHiddenIDs(ctx)
	if effectivelyHidden[tag.ID] {
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

	// Direct children for tag detail response (exclude effectively hidden ones)
	allChildren, _ := h.tagService.GetTagChildren(ctx, tag.ID)
	children := make([]models.Tag, 0, len(allChildren))
	for _, ch := range allChildren {
		if !effectivelyHidden[ch.ID] {
			children = append(children, ch)
		}
	}

	// Hierarchical children for sub-nav
	childItems, _ := h.tagService.GetHierarchicalNavTags(ctx, &tag.ID)

	// Posts for this tag (published only)
	posts, total, err := h.tagService.GetPostsByTag(ctx, tag.ID, int32(page), int32(perPage), true)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	tagPostIDs := make([]int64, len(posts))
	for i, p := range posts {
		tagPostIDs[i] = p.ID
	}
	tagPostTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, tagPostIDs)

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		postResponses[i] = postByTagToResponse(p, tagPostTagsMap[p.ID])
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
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, []int64{tag.ID})
	var tagLoc *models.TagLocation
	if l, ok := locMap[tag.ID]; ok {
		tagLoc = &l
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"tag":         tagToFullResponse(tag, parents, children, tagLoc),
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

	// Fetch locations for all tags in one query.
	allTagIDs := make([]int64, len(tags))
	for i, t := range tags {
		allTagIDs[i] = t.ID
	}
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, allTagIDs)

	effectivelyHidden, _ := h.tagService.EffectivelyHiddenIDs(ctx)

	// Filter hidden tags for public view
	visible := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		if !effectivelyHidden[t.ID] {
			parents, _ := h.tagService.GetTagParents(ctx, t.ID)
			allChildren, _ := h.tagService.GetTagChildren(ctx, t.ID)
			children := make([]models.Tag, 0, len(allChildren))
			for _, ch := range allChildren {
				if !effectivelyHidden[ch.ID] {
					children = append(children, ch)
				}
			}
			var loc *models.TagLocation
			if l, ok := locMap[t.ID]; ok {
				loc = &l
			}
			visible = append(visible, tagToFullResponse(t, parents, children, loc))
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"tags":  visible,
		"total": len(visible),
	})
}

// GetMapPage returns all tags that have coordinates, categorised by type
// (country / city / other) for the public /map page.
func (h *PagesHandler) GetMapPage(c echo.Context) error {
	ctx := c.Request().Context()

	// Find the base category tags used to determine type.
	baseTags, _ := h.repo.FindTagsByNames(ctx, []string{"country", "countries", "city", "cities", "year", "years"})

	countryDescIDs := map[int64]bool{}
	cityDescIDs := map[int64]bool{}
	var yearTagID int64

	for _, bt := range baseTags {
		name := strings.ToLower(bt.Name)
		descs, _ := h.repo.GetTagDescendants(ctx, bt.ID)
		for _, d := range descs {
			switch name {
			case "country", "countries":
				countryDescIDs[d.ID] = true
			case "city", "cities":
				cityDescIDs[d.ID] = true
			}
		}
		if name == "year" || name == "years" {
			yearTagID = bt.ID
		}
	}

	allTags, _ := h.tagService.ListTags(ctx, true, false)
	tagIDs := make([]int64, len(allTags))
	for i, t := range allTags {
		tagIDs[i] = t.ID
	}
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, tagIDs)

	var yearMap map[int64][]repository.PostTagInfo
	if yearTagID > 0 {
		yearMap, _ = h.repo.GetYearTagsByLocationTagIDs(ctx, tagIDs, yearTagID)
	}

	effectivelyHiddenMap, _ := h.tagService.EffectivelyHiddenIDs(ctx)

	mapTags := []map[string]interface{}{}
	for _, t := range allTags {
		if effectivelyHiddenMap[t.ID] {
			continue
		}
		loc, ok := locMap[t.ID]
		if !ok {
			continue
		}
		tagType := "other"
		if cityDescIDs[t.ID] {
			tagType = "city"
		} else if countryDescIDs[t.ID] {
			tagType = "country"
		}

		years := yearMap[t.ID]
		if years == nil {
			years = []repository.PostTagInfo{}
		}

		mapTags = append(mapTags, map[string]interface{}{
			"name":       t.Name,
			"slug":       t.Slug,
			"post_count": t.PostCount,
			"lat":        loc.Latitude,
			"lng":        loc.Longitude,
			"type":       tagType,
			"years":      years,
		})
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"tags": mapTags})
}
