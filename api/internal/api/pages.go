package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

type PagesHandler struct {
	repo            *repository.Repository
	postService     *services.PostService
	tagService      *services.TagService
	mediaService    *services.MediaService
	settingsService *services.SettingsService
	cacheService    *services.CacheService
}

func NewPagesHandler(repo *repository.Repository, postService *services.PostService, tagService *services.TagService, mediaService *services.MediaService, settingsService *services.SettingsService, cacheService *services.CacheService) *PagesHandler {
	return &PagesHandler{
		repo:            repo,
		postService:     postService,
		tagService:      tagService,
		mediaService:    mediaService,
		settingsService: settingsService,
		cacheService:    cacheService,
	}
}

var pagePublicSettingKeys = map[string]bool{
	"blog_title":             true,
	"blog_subtitle":          true,
	"author_name":            true,
	"posts_per_page":         true,
	"default_theme":          true,
	"show_view_counts":       true,
	"use_thumbnails":         true,
	"about_post_id":          true,
	"home_page_post_id":      true,
	"show_immersive_excerpt": true,
	"min_tag_posts_to_show":  true,
	"show_tag_cloud":         true,
	"map_mode":               true,
	"timeline_mode":          true,
}

// GetHomePage returns all data needed to render the public homepage.
func (h *PagesHandler) GetHomePage(c echo.Context) error {
	ctx := c.Request().Context()
	user := c.Get("user")
	publicOnly := user == nil

	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}

	yearFrom, _ := strconv.Atoi(c.QueryParam("year_from"))
	yearTo, _ := strconv.Atoi(c.QueryParam("year_to"))
	hasYearFilter := yearFrom > 0 && yearTo > 0 && yearFrom <= yearTo

	// Try cache for public requests (TTL 15 minutes) — skip when year filter is active
	cacheKey := fmt.Sprintf("homepage_p%d.json", page)
	if publicOnly && !hasYearFilter {
		if data, err := h.cacheService.GetWithTTL(ctx, cacheKey, 15*time.Minute); err == nil {
			return c.Blob(http.StatusOK, "application/json; charset=utf-8", data)
		}
	}

	allSettings, _ := h.settingsService.GetAllSettings(ctx)

	// Custom Home Page logic: if home_page_post_id is set, return that specific post.
	// We only apply this on the first page of the index if no other filters are active.
	if page == 1 && !hasYearFilter {
		if hpIDStr, ok := allSettings["home_page_post_id"]; ok && hpIDStr != "" {
			hpPost, err := h.postService.GetPostBySlug(ctx, hpIDStr)
			if err == nil && (hpPost.Status == "published" || !publicOnly) {
				postTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, []int64{hpPost.ID})
				hpPostType := getPostType(hpPost.Status, postTagsMap[hpPost.ID])
				if hpPostType == "page" {
					ancestorsMap := fetchAncestorsMap(ctx, h.repo, postTagsMap)
					postTagsMap = expandPostTagsWithAncestors(postTagsMap, ancestorsMap, publicOnly)

					minPosts := getMinTagPostsSetting(allSettings)
					var excludeTagIDs map[int64]bool
					if publicOnly {
						excludeTagIDs, _ = h.tagService.PublicHiddenTagIDs(ctx, minPosts)
					}
					effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(ctx)

					resp := postToResponse(hpPost, postTagsMap[hpPost.ID], excludeTagIDs)
					resp["type"] = "page" // Force type to page as we verified it above

					htmlContent, _ := h.postService.RenderContent(hpPost.Content)
					resp["content_html"] = htmlContent

					media, _ := h.mediaService.GetMediaByContent(ctx, hpPost.Content, hpPost.ThumbnailPath.String)
					mediaObjs := make([]map[string]interface{}, 0, len(media))
					for _, m := range media {
						mediaObjs = append(mediaObjs, map[string]interface{}{
							"path":     "/" + strings.TrimPrefix(m.OriginalPath, "originals/"),
							"alt_text": nullString(m.AltText),
						})
					}
					resp["media"] = mediaObjs

					if !publicOnly {
						injectPostHiddenFieldsFromInfo(resp, hpPost.Status, postTagsMap[hpPost.ID], effectiveHiddenPosts)
					}

					// Public settings subset
					publicSettings := make(map[string]string)
					for k, v := range allSettings {
						if pagePublicSettingKeys[k] {
							publicSettings[k] = v
						}
					}

					return c.JSON(http.StatusOK, map[string]interface{}{
						"posts": []map[string]interface{}{resp},
						"pagination": map[string]interface{}{
							"page":     1,
							"per_page": 1,
							"total":    1,
							"pages":    1,
						},
						"settings": publicSettings,
					})
				}
			}
		}
	}

	perPageStr := getSettingOr(allSettings, "posts_per_page", "10")
	perPage, _ := strconv.Atoi(perPageStr)
	if perPage < 1 {
		perPage = 10
	}
	if qpp, _ := strconv.Atoi(c.QueryParam("per_page")); qpp > 0 {
		perPage = qpp
	}

	// Published posts
	listParams := services.ListPostsParams{
		Page:          int32(page),
		PerPage:       int32(perPage),
		IncludeDrafts: false,
		IncludeHidden: !publicOnly,
	}
	if hasYearFilter {
		listParams.YearFrom = yearFrom
		listParams.YearTo = yearTo
	}
	posts, total, err := h.postService.ListPosts(ctx, listParams)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	postIDs := make([]int64, len(posts))
	for i, p := range posts {
		postIDs[i] = p.ID
	}
	postTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, postIDs)
	ancestorsMap := fetchAncestorsMap(ctx, h.repo, postTagsMap)
	postTagsMap = expandPostTagsWithAncestors(postTagsMap, ancestorsMap, publicOnly)

	minPosts := getMinTagPostsSetting(allSettings)
	var excludeTagIDs map[int64]bool
	if publicOnly {
		excludeTagIDs, _ = h.tagService.PublicHiddenTagIDs(ctx, minPosts)
	}
	effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(ctx)

	postResponses := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		if publicOnly && !IsPostVisibleToPublic(postTagsMap[p.ID], effectiveHiddenPosts) {
			continue
		}
		resp := postToResponse(p, postTagsMap[p.ID], excludeTagIDs)
		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, p.Status, postTagsMap[p.ID], effectiveHiddenPosts)
		}
		postResponses = append(postResponses, resp)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	// Fetch hierarchical tags for nav and cloud with min_tag_posts_to_show filter.
	cloud, _ := h.tagService.GetTagCloud(ctx, 20, publicOnly, minPosts)
	navTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly, minPosts)

	// Public settings subset
	publicSettings := make(map[string]string)
	for k, v := range allSettings {
		if pagePublicSettingKeys[k] {
			publicSettings[k] = v
		}
	}

	resp := map[string]interface{}{
		"posts": postResponses,
		"pagination": map[string]interface{}{
			"page":     page,
			"per_page": perPage,
			"total":    total,
			"pages":    pages,
		},
		"tag_cloud": cloud,
		"menu":      navTags,
		"settings":  publicSettings,
	}

	if publicOnly && !hasYearFilter {
		if data, err := json.Marshal(resp); err == nil {
			_ = h.cacheService.Set(ctx, cacheKey, data)
		}
	}

	return c.JSON(http.StatusOK, resp)
}

// GetTagPage returns all data needed to render a tag archive page.
func (h *PagesHandler) GetTagPage(c echo.Context) error {
	ctx := c.Request().Context()
	slug := c.Param("slug")
	user := c.Get("user")
	publicOnly := user == nil

	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}

	yearFrom, _ := strconv.Atoi(c.QueryParam("year_from"))
	yearTo, _ := strconv.Atoi(c.QueryParam("year_to"))
	hasYearFilter := yearFrom > 0 && yearTo > 0 && yearFrom <= yearTo

	// Try cache for public requests (TTL 15 minutes) — skip when year filter is active
	cacheKey := fmt.Sprintf("tagpage_%s_p%d.json", slug, page)
	if publicOnly && !hasYearFilter {
		if data, err := h.cacheService.GetWithTTL(ctx, cacheKey, 15*time.Minute); err == nil {
			return c.Blob(http.StatusOK, "application/json; charset=utf-8", data)
		}
	}

	tag, err := h.tagService.GetTagBySlug(ctx, slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	effectivelyHidden, _ := h.tagService.EffectivelyHiddenIDs(ctx)
	if publicOnly && effectivelyHidden[tag.ID] {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}
	effectiveHiddenPostsTagIDs, _ := h.tagService.EffectivelyHiddenPostsTagIDs(ctx)

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
	inBreadcrumbs, _ := h.tagService.InBreadcrumbsIDs(ctx)

	minPosts := getMinTagPostsSetting(allSettings)

	// Direct children for tag detail response (exclude effectively hidden ones)
	allChildren, _ := h.tagService.GetTagChildren(ctx, tag.ID, publicOnly, minPosts)
	children := make([]models.Tag, 0, len(allChildren))
	for _, ch := range allChildren {
		if !publicOnly || !effectivelyHidden[ch.ID] {
			children = append(children, ch)
		}
	}

	// Hierarchical children for sub-nav.
	// If the tag (or any of its parents) has _with_related, replace the normal
	// sub-nav with co-occurring tags from posts, marked as related.
	withRelatedIDs, _ := h.tagService.WithRelatedIDs(ctx)
	var childItems []services.NavTagNode
	if useCoOccurrence := withRelatedIDs[tag.ID] || func() bool {
		parents, _ := h.tagService.GetTagParents(ctx, tag.ID)
		for _, p := range parents {
			if withRelatedIDs[p.ID] {
				return true
			}
		}
		return false
	}(); useCoOccurrence {
		coTags, _ := h.repo.GetCoOccurringTags(ctx, tag.ID, publicOnly)
		for _, t := range coTags {
			if publicOnly && effectivelyHidden[t.ID] {
				continue
			}
			childItems = append(childItems, services.NavTagNode{
				ID:        t.ID,
				Name:      t.Name,
				Slug:      t.Slug,
				PostCount: t.PostCount,
				IsRelated: true,
				Children:  []services.NavTagNode{},
			})
		}
	} else {
		childItems, _ = h.tagService.GetHierarchicalNavTags(ctx, &tag.ID, publicOnly, minPosts)
	}

	// Root-level nav tags for global navigation
	rootNavTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly, minPosts)

	// Posts for this tag (published only)
	posts, total, err := h.tagService.GetPostsByTag(ctx, tag.ID, int32(page), int32(perPage), publicOnly, false, yearFrom, yearTo)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	tagPostIDs := make([]int64, len(posts))
	for i, p := range posts {
		tagPostIDs[i] = p.ID
	}
	tagPostTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, tagPostIDs)
	tagAncestorsMap := fetchAncestorsMap(ctx, h.repo, tagPostTagsMap)
	tagPostTagsMap = expandPostTagsWithAncestors(tagPostTagsMap, tagAncestorsMap, publicOnly)

	var excludeTagIDs map[int64]bool
	if publicOnly {
		excludeTagIDs, _ = h.tagService.PublicHiddenTagIDs(ctx, minPosts)
	}

	postResponses := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		if publicOnly && !IsPostVisibleToPublic(tagPostTagsMap[p.ID], effectiveHiddenPostsTagIDs) {
			continue
		}
		resp := postToResponse(p, tagPostTagsMap[p.ID], excludeTagIDs)
		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, p.Status, tagPostTagsMap[p.ID], effectiveHiddenPostsTagIDs)
		}
		postResponses = append(postResponses, resp)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	effectivelyHiddenMap, _ := h.tagService.EffectivelyHiddenIDs(ctx)
	breadcrumbs := make([]map[string]interface{}, 0, len(ancestors))
	for _, a := range ancestors {
		if !excludeTagIDs[a.ID] && inBreadcrumbs[a.ID] {
			crumb := tagToListItem(a)
			if !publicOnly {
				crumb["is_hidden_posts"] = effectiveHiddenPostsTagIDs[a.ID]
				crumb["is_hidden"] = effectivelyHiddenMap[a.ID]
			}
			breadcrumbs = append(breadcrumbs, crumb)
		}
	}

	parents, _ := h.tagService.GetTagParents(ctx, tag.ID)
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, []int64{tag.ID})
	var tagLoc *models.TagLocation
	if l, ok := locMap[tag.ID]; ok {
		tagLoc = &l
	}
	tagResp := tagToFullResponse(tag, parents, children, tagLoc, excludeTagIDs)
	if !publicOnly {
		injectTagHiddenFields(tagResp, tag, effectiveHiddenPostsTagIDs)
		tagResp["is_hidden"] = effectivelyHiddenMap[tag.ID]
	}
	resp := map[string]interface{}{
		"tag":          tagResp,
		"breadcrumbs":  breadcrumbs,
		"posts":        postResponses,
		"menu":         rootNavTags,
		"nav_children": childItems,
		"pagination": map[string]interface{}{
			"page":     page,
			"per_page": perPage,
			"total":    total,
			"pages":    pages,
		},
	}

	if publicOnly && !hasYearFilter {
		if data, err := json.Marshal(resp); err == nil {
			_ = h.cacheService.Set(ctx, cacheKey, data)
		}
	}

	return c.JSON(http.StatusOK, resp)
}

// GetTagsPage returns data for the tags directory page.
func (h *PagesHandler) GetTagsPage(c echo.Context) error {
	ctx := c.Request().Context()
	user := c.Get("user")
	publicOnly := user == nil

	tags, err := h.tagService.ListTags(ctx, true, publicOnly)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Fetch locations for all tags in one query.
	allTagIDs := make([]int64, len(tags))
	for i, t := range tags {
		allTagIDs[i] = t.ID
	}
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, allTagIDs)

	effectiveHiddenPostsTagIDs, _ := h.tagService.EffectivelyHiddenPostsTagIDs(ctx)

	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	minPosts := getMinTagPostsSetting(allSettings)
	var excludeTagIDs map[int64]bool
	var effectivelyHiddenMap map[int64]bool
	if publicOnly {
		excludeTagIDs, _ = h.tagService.PublicHiddenTagIDs(ctx, minPosts)
	} else {
		effectivelyHiddenMap, _ = h.tagService.EffectivelyHiddenIDs(ctx)
	}

	// Filter hidden tags for public view
	visible := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		if !publicOnly || !excludeTagIDs[t.ID] {
			parents, _ := h.tagService.GetTagParents(ctx, t.ID)
			allChildren, _ := h.tagService.GetTagChildren(ctx, t.ID, publicOnly, minPosts)
			children := make([]models.Tag, 0, len(allChildren))
			for _, ch := range allChildren {
				if !publicOnly || !excludeTagIDs[ch.ID] {
					children = append(children, ch)
				}
			}
			var loc *models.TagLocation
			if l, ok := locMap[t.ID]; ok {
				loc = &l
			}
			tagResp := tagToFullResponse(t, parents, children, loc, excludeTagIDs)
			if !publicOnly {
				injectTagHiddenFields(tagResp, t, effectiveHiddenPostsTagIDs)
				tagResp["is_hidden"] = effectivelyHiddenMap[t.ID]
			}
			visible = append(visible, tagResp)
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
	user := c.Get("user")
	publicOnly := user == nil

	mapSettings, _ := h.settingsService.GetAllSettings(ctx)

	mapMode := mapSettings["map_mode"]
	if mapMode == "" {
		mapMode = "off"
	}

	if publicOnly && mapMode != "all" {
		return echo.NewHTTPError(http.StatusNotFound, "map not found")
	}
	if !publicOnly && mapMode == "off" {
		return echo.NewHTTPError(http.StatusNotFound, "map not found")
	}

	// Parse optional year range filter from the timeline component.
	var yearRangeFilter map[int64]int64 // tagID → scoped post_count; nil = no filter
	yearFromStr := c.QueryParam("year_from")
	yearToStr := c.QueryParam("year_to")
	if yearFromStr != "" && yearToStr != "" {
		yearFrom, errFrom := strconv.Atoi(yearFromStr)
		yearTo, errTo := strconv.Atoi(yearToStr)
		if errFrom == nil && errTo == nil && yearFrom <= yearTo {
			rangeResults, _ := h.repo.ListMapTagsForYearRange(ctx, yearFrom, yearTo)
			yearRangeFilter = make(map[int64]int64, len(rangeResults))
			for _, r := range rangeResults {
				yearRangeFilter[r.TagID] = r.PostCount
			}
		}
	}

	var minMapPosts int64
	if publicOnly {
		minMapPosts = getMinTagPostsSetting(mapSettings)
	}

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

	allTags, _ := h.tagService.ListTags(ctx, true, publicOnly)
	tagIDs := make([]int64, len(allTags))
	for i, t := range allTags {
		tagIDs[i] = t.ID
	}
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, tagIDs)

	var yearMap map[int64][]repository.PostTagInfo
	if yearTagID > 0 {
		yearMap, _ = h.repo.GetYearTagsByLocationTagIDs(ctx, tagIDs, yearTagID)
	}

	excludeTagIDs, _ := h.tagService.PublicHiddenTagIDs(ctx, minMapPosts)
	hierarchicalCounts, _ := h.tagService.GetHierarchicalPostCounts(ctx, publicOnly)
	effectivelyHiddenMap, _ := h.tagService.EffectivelyHiddenIDs(ctx)

	mapTags := []map[string]interface{}{}
	for _, t := range allTags {
		if publicOnly && excludeTagIDs[t.ID] {
			continue
		}
		loc, ok := locMap[t.ID]
		if !ok {
			continue
		}

		// When a year range filter is active, skip tags outside the filtered set.
		if yearRangeFilter != nil {
			if _, inRange := yearRangeFilter[t.ID]; !inRange {
				continue
			}
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

		var postCount int64
		if yearRangeFilter != nil {
			postCount = yearRangeFilter[t.ID]
		} else {
			postCount = hierarchicalCounts[t.ID]
			if postCount == 0 {
				postCount = int64(t.PostCount)
			}
		}

		entry := map[string]interface{}{
			"name":       t.Name,
			"slug":       t.Slug,
			"post_count": postCount,
			"lat":        loc.Latitude,
			"lng":        loc.Longitude,
			"type":       tagType,
			"years":      years,
		}
		if !publicOnly {
			entry["is_hidden"] = effectivelyHiddenMap[t.ID]
		}
		mapTags = append(mapTags, entry)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"tags": mapTags})
}

// expandPostTagsWithAncestors takes a postID→tags map and adds ancestor tags for each direct tag,
// filtering out is_hidden ancestors when publicOnly is true. Deduplication is per-post.
func expandPostTagsWithAncestors(
	postTagsMap map[int64][]repository.PostTagInfo,
	ancestorsMap map[int64][]repository.PostTagInfo,
	publicOnly bool,
) map[int64][]repository.PostTagInfo {
	result := make(map[int64][]repository.PostTagInfo, len(postTagsMap))
	for postID, tags := range postTagsMap {
		seen := make(map[int64]bool, len(tags)*3)
		expanded := make([]repository.PostTagInfo, 0, len(tags)*2)
		for _, t := range tags {
			if seen[t.ID] {
				continue
			}
			seen[t.ID] = true
			if publicOnly && strings.HasPrefix(t.Slug, "_") {
				continue
			}
			expanded = append(expanded, t)
			for _, anc := range ancestorsMap[t.ID] {
				if seen[anc.ID] {
					continue
				}
				seen[anc.ID] = true
				if publicOnly && strings.HasPrefix(anc.Slug, "_") {
					continue
				}
				expanded = append(expanded, anc)
			}
		}
		result[postID] = expanded
	}
	return result
}

// tagToPostTagInfo converts a models.Tag to a lightweight PostTagInfo for ancestor expansion.
func tagToPostTagInfo(t models.Tag) repository.PostTagInfo {
	return repository.PostTagInfo{
		ID:   t.ID,
		Name: t.Name,
		Slug: t.Slug,
	}
}

// fetchAncestorsMap fetches ancestor tags for each unique tag ID in the postTagsMap.
// Results are cached per tag ID to avoid redundant queries.
func fetchAncestorsMap(ctx context.Context, repo *repository.Repository, postTagsMap map[int64][]repository.PostTagInfo) map[int64][]repository.PostTagInfo {
	uniqueTagIDs := make(map[int64]bool)
	for _, tags := range postTagsMap {
		for _, t := range tags {
			uniqueTagIDs[t.ID] = true
		}
	}
	ancestorsMap := make(map[int64][]repository.PostTagInfo, len(uniqueTagIDs))
	for tagID := range uniqueTagIDs {
		ancestors, _ := repo.GetTagAncestors(ctx, tagID)
		infos := make([]repository.PostTagInfo, len(ancestors))
		for i, a := range ancestors {
			infos[i] = tagToPostTagInfo(a)
		}
		ancestorsMap[tagID] = infos
	}
	return ancestorsMap
}

// getMinTagPostsSetting reads the min_tag_posts_to_show setting; returns 0 (no filter) when unset.
func getMinTagPostsSetting(settings map[string]string) int64 {
	v, _ := strconv.ParseInt(getSettingOr(settings, "min_tag_posts_to_show", "0"), 10, 64)
	if v < 0 {
		return 0
	}
	return v
}

// GetNavMenu returns the hierarchical tag tree (or custom menu) for navigation,
// scoped to the current user's auth level.
// GET /api/pages/nav
func (h *PagesHandler) GetNavMenu(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	allSettings, _ := h.settingsService.GetAllSettings(ctx)

	if allSettings["nav_menu_mode"] == "custom" {
		raw := allSettings["custom_nav_menu"]
		if raw != "" {
			var nodes []services.NavTagNode
			if err := json.Unmarshal([]byte(raw), &nodes); err == nil {
				return c.JSON(http.StatusOK, map[string]interface{}{"menu": nodes})
			}
		}
		return c.JSON(http.StatusOK, map[string]interface{}{"menu": []services.NavTagNode{}})
	}

	minPosts := int64(0)
	if publicOnly {
		minPosts = getMinTagPostsSetting(allSettings)
	}

	navTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly, minPosts)
	return c.JSON(http.StatusOK, map[string]interface{}{"menu": navTags})
}
