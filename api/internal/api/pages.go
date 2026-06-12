package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type PagesHandler struct {
	repo            repository.Repository
	postService     *services.PostService
	tagService      *services.TagService
	mediaService    *services.MediaService
	settingsService *services.SettingsService
	cacheService    *services.CacheService
}

func NewPagesHandler(repo repository.Repository, postService *services.PostService, tagService *services.TagService, mediaService *services.MediaService, settingsService *services.SettingsService, cacheService *services.CacheService) *PagesHandler {
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

	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	perPageStr := getSettingOr(allSettings, "posts_per_page", "10")
	defaultPerPage64, _ := strconv.ParseInt(perPageStr, 10, 32)
	defaultPerPage := int(defaultPerPage64)
	page, perPage := ParsePaginationParams(c, defaultPerPage)

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

	showViewCounts := allSettings["show_view_counts"] == "true"
	snap, _ := h.tagService.GetTagSnapshot(ctx)

	// Custom Home Page logic: if home_page_post_id is set, return that specific post.
	// We only apply this on the first page of the index if no other filters are active.
	if page == 1 && !hasYearFilter {
		if hpIDStr, ok := allSettings["home_page_post_id"]; ok && hpIDStr != "" {
			hpPost, err := h.postService.GetPostBySlug(ctx, hpIDStr)
			if err == nil && (hpPost.Status == "published" || hpPost.Status == "page" || !publicOnly) {
				postTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, []int64{hpPost.ID})
				hpPostType := hpPost.Type
				if hpPostType == "page" {
					postTagsMap = h.expandPostTagsWithAncestors(ctx, postTagsMap, publicOnly)

					minPosts := getMinTagPostsSetting(allSettings)
					var excludeTagIDs map[int64]bool
					var effectiveHiddenPosts map[int64]bool
					if snap != nil {
						if publicOnly {
							excludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
						}
						effectiveHiddenPosts = snap.EffectiveHidesPosts
					}

					resp := postToResponse(hpPost, postTagsMap[hpPost.ID], excludeTagIDs)
					resp["type"] = "page" // Force type to page as we verified it above
					if !showViewCounts {
						delete(resp, "view_count")
					}

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

	// Published posts
	listParams := services.ListPostsParams{
		Page:          page,
		PerPage:       perPage,
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
	postTagsMap = h.expandPostTagsWithAncestors(ctx, postTagsMap, publicOnly)

	minPosts := getMinTagPostsSetting(allSettings)
	var excludeTagIDs map[int64]bool
	var effectiveHiddenPosts map[int64]bool
	if snap != nil {
		if publicOnly {
			excludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
		}
		effectiveHiddenPosts = snap.EffectiveHidesPosts
	}

	postResponses := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		if publicOnly && !IsPostVisibleToPublic(postTagsMap[p.ID], effectiveHiddenPosts) {
			continue
		}
		resp := postToResponse(p, postTagsMap[p.ID], excludeTagIDs)
		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, p.Status, postTagsMap[p.ID], effectiveHiddenPosts)
		}
		if !showViewCounts {
			delete(resp, "view_count")
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

	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	perPageStr := getSettingOr(allSettings, "posts_per_page", "10")
	defaultPerPage64, _ := strconv.ParseInt(perPageStr, 10, 32)
	defaultPerPage := int(defaultPerPage64)
	page, perPage := ParsePaginationParams(c, defaultPerPage)

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

	snap, _ := h.tagService.GetTagSnapshot(ctx)
	tag, err := h.tagService.GetTagBySlug(ctx, slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	minPosts := getMinTagPostsSetting(allSettings)
	var effectivelyHidden map[int64]bool
	var excludeTagIDs map[int64]bool
	var effectiveHiddenPostsTagIDs map[int64]bool
	var withRelatedIDs map[int64]bool
	var inBreadcrumbs map[int64]bool
	if snap != nil {
		effectivelyHidden = snap.EffectiveHidden
		effectiveHiddenPostsTagIDs = snap.EffectiveHidesPosts
		withRelatedIDs = snap.WithRelatedIDs()
		inBreadcrumbs = snap.InBreadcrumbsIDs()
		if publicOnly {
			excludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
			if excludeTagIDs[tag.ID] {
				return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
			}
		}
	}

	showViewCounts := allSettings["show_view_counts"] == "true"

	// Breadcrumb ancestors
	ancestors, _ := h.repo.GetTagAncestors(ctx, tag.ID)

	// Direct children for tag detail response (exclude effectively hidden ones)
	allChildren, _ := h.tagService.GetTagChildren(ctx, tag.ID, publicOnly, minPosts)
	children := make([]models.Tag, 0, len(allChildren))
	for _, ch := range allChildren {
		if !publicOnly || (effectivelyHidden != nil && !effectivelyHidden[ch.ID]) {
			children = append(children, ch)
		}
	}

	// Hierarchical children for sub-nav.
	// If the tag (or any of its parents) has ShowRelated=true, replace the normal
	// sub-nav with co-occurring tags from posts, marked as related.

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
	posts, total, err := h.tagService.GetPostsByTag(ctx, tag.ID, page, perPage, publicOnly, false, yearFrom, yearTo)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	tagPostIDs := make([]int64, len(posts))
	for i, p := range posts {
		tagPostIDs[i] = p.ID
	}
	tagPostTagsMap, _ := h.repo.GetTagsByPostIDs(ctx, tagPostIDs)
	tagPostTagsMap = h.expandPostTagsWithAncestors(ctx, tagPostTagsMap, publicOnly)

	postResponses := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		if publicOnly && !IsPostVisibleToPublic(tagPostTagsMap[p.ID], effectiveHiddenPostsTagIDs) {
			continue
		}
		resp := postToResponse(p, tagPostTagsMap[p.ID], excludeTagIDs)
		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, p.Status, tagPostTagsMap[p.ID], effectiveHiddenPostsTagIDs)
		}
		if !showViewCounts {
			delete(resp, "view_count")
		}
		postResponses = append(postResponses, resp)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	breadcrumbs := make([]map[string]interface{}, 0, len(ancestors))
	for _, a := range ancestors {
		if !excludeTagIDs[a.ID] && inBreadcrumbs[a.ID] {
			crumb := tagToListItem(a)
			if !publicOnly {
				crumb["is_hidden_posts"] = effectiveHiddenPostsTagIDs[a.ID]
				crumb["is_hidden"] = effectivelyHidden[a.ID]
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
		tagResp["is_hidden"] = effectivelyHidden[tag.ID]
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

	g, err := h.tagService.GetTagSnapshot(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	minPosts := getMinTagPostsSetting(allSettings)

	// Fetch locations for all tags in one query.
	tagIDs := make([]int64, 0, len(g.ByID))
	for id := range g.ByID {
		tagIDs = append(tagIDs, id)
	}
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, tagIDs)

	excludeTagIDs := make(map[int64]bool)
	if publicOnly {
		for id := range g.EffectiveHidden {
			excludeTagIDs[id] = true
		}
		if minPosts > 0 {
			for id, count := range g.CountsPublic {
				if count < minPosts {
					excludeTagIDs[id] = true
				}
			}
		}
	}

	visible := make([]map[string]interface{}, 0)
	for id, t := range g.ByID {
		if publicOnly && excludeTagIDs[id] {
			continue
		}

		parents := make([]models.Tag, 0)
		for _, pid := range g.Parents[id] {
			parents = append(parents, g.ByID[pid])
		}
		children := make([]models.Tag, 0)
		for _, cid := range g.Children[id] {
			if publicOnly && excludeTagIDs[cid] {
				continue
			}
			children = append(children, g.ByID[cid])
		}

		var loc *models.TagLocation
		if l, ok := locMap[id]; ok {
			loc = &l
		}

		tagResp := tagToFullResponse(t, parents, children, loc, excludeTagIDs)
		tagResp["effective_hidden"] = g.EffectiveHidden[id]
		tagResp["effective_hides_posts"] = g.EffectiveHidesPosts[id]
		tagResp["post_count"] = g.CountsAdmin[id]

		if publicOnly {
			tagResp["post_count"] = g.CountsPublic[id]
		} else {
			tagResp["is_hidden"] = g.EffectiveHidden[id]
			if via, ok := g.HiddenVia[id]; ok {
				tagResp["hidden_via"] = via
			}
		}
		visible = append(visible, tagResp)
	}

	// Stable sort by name
	sort.Slice(visible, func(i, j int) bool {
		return visible[i]["name"].(string) < visible[j]["name"].(string)
	})

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

	g, err := h.tagService.GetTagSnapshot(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

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
	countryDescIDs := make(map[int64]bool)
	cityDescIDs := make(map[int64]bool)

	for id, t := range g.ByID {
		name := strings.ToLower(t.Name)
		switch name {
		case "country", "countries":
			// BFS descendants
			queue := []int64{id}
			for len(queue) > 0 {
				cur := queue[0]
				queue = queue[1:]
				for _, cid := range g.Children[cur] {
					if !countryDescIDs[cid] {
						countryDescIDs[cid] = true
						queue = append(queue, cid)
					}
				}
			}
		case "city", "cities":
			// BFS descendants
			queue := []int64{id}
			for len(queue) > 0 {
				cur := queue[0]
				queue = queue[1:]
				for _, cid := range g.Children[cur] {
					if !cityDescIDs[cid] {
						cityDescIDs[cid] = true
						queue = append(queue, cid)
					}
				}
			}
		}
	}

	tagIDs := make([]int64, 0, len(g.ByID))
	for id := range g.ByID {
		tagIDs = append(tagIDs, id)
	}
	locMap, _ := h.tagService.GetTagLocationsByTagIDs(ctx, tagIDs)
	yearMap, _ := h.repo.GetYearTagsByLocationTagIDs(ctx, tagIDs)

	mapTags := []map[string]interface{}{}
	for id, t := range g.ByID {
		if publicOnly && g.EffectiveHidden[id] {
			continue
		}
		if publicOnly && minMapPosts > 0 && g.CountsPublic[id] < minMapPosts {
			continue
		}

		loc, ok := locMap[id]
		if !ok {
			continue
		}

		// When a year range filter is active, skip tags outside the filtered set.
		if yearRangeFilter != nil {
			if _, inRange := yearRangeFilter[id]; !inRange {
				continue
			}
		}

		tagType := "other"
		if cityDescIDs[id] {
			tagType = "city"
		} else if countryDescIDs[id] {
			tagType = "country"
		}

		years := yearMap[id]
		if years == nil {
			years = []repository.PostTagInfo{}
		}

		var postCount int64
		if yearRangeFilter != nil {
			postCount = yearRangeFilter[id]
		} else {
			postCount = g.CountsAdmin[id]
			if publicOnly {
				postCount = g.CountsPublic[id]
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
			entry["is_hidden"] = g.EffectiveHidden[id]
			if via, ok := g.HiddenVia[id]; ok {
				entry["hidden_via"] = via
			}
		}
		mapTags = append(mapTags, entry)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"tags": mapTags})
}

// expandPostTagsWithAncestors takes a postID→tags map and adds ancestor tags for each direct tag,
// filtering out is_hidden ancestors when publicOnly is true. Deduplication is per-post.
func (h *PagesHandler) expandPostTagsWithAncestors(
	ctx context.Context,
	postTagsMap map[int64][]repository.PostTagInfo,
	publicOnly bool,
) map[int64][]repository.PostTagInfo {
	g, err := h.tagService.GetTagSnapshot(ctx)
	if err != nil {
		return postTagsMap
	}

	result := make(map[int64][]repository.PostTagInfo, len(postTagsMap))
	for postID, tags := range postTagsMap {
		seen := make(map[int64]bool, len(tags)*3)
		expanded := make([]repository.PostTagInfo, 0, len(tags)*2)
		for _, t := range tags {
			if seen[t.ID] {
				continue
			}
			seen[t.ID] = true
			if publicOnly && g.EffectiveHidden[t.ID] {
				continue
			}
			expanded = append(expanded, t)

			// BFS from this tag in-memory
			queue := []int64{t.ID}
			for len(queue) > 0 {
				cur := queue[0]
				queue = queue[1:]

				for _, pid := range g.Parents[cur] {
					if seen[pid] {
						continue
					}
					seen[pid] = true
					if publicOnly && g.EffectiveHidden[pid] {
						continue
					}
					p := g.ByID[pid]
					expanded = append(expanded, repository.PostTagInfo{
						ID:   p.ID,
						Name: p.Name,
						Slug: p.Slug,
					})
					queue = append(queue, pid)
				}
			}
		}
		result[postID] = expanded
	}
	return result
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
