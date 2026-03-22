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
	settingsService *services.SettingsService
	cacheService    *services.CacheService
}

func NewPagesHandler(repo *repository.Repository, postService *services.PostService, tagService *services.TagService, settingsService *services.SettingsService, cacheService *services.CacheService) *PagesHandler {
	return &PagesHandler{
		repo:            repo,
		postService:     postService,
		tagService:      tagService,
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
	"show_immersive_excerpt": true,
	"min_tag_posts_to_show":  true,
	"show_tag_cloud":         true,
	"enable_map":             true,
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

	// Try cache for public requests (TTL 15 minutes)
	cacheKey := fmt.Sprintf("homepage_p%d.json", page)
	if publicOnly {
		if data, err := h.cacheService.GetWithTTL(ctx, cacheKey, 15*time.Minute); err == nil {
			return c.Blob(http.StatusOK, "application/json; charset=utf-8", data)
		}
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
		IncludeDrafts: false, // Never show drafts in public part
		IncludeHidden: !publicOnly,
	})
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

	effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(ctx)

	postResponses := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		if publicOnly && !IsPostVisibleToPublic(postTagsMap[p.ID], effectiveHiddenPosts) {
			continue
		}
		resp := postToResponse(p, postTagsMap[p.ID])
		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, p.Status, postTagsMap[p.ID], effectiveHiddenPosts)
		}
		postResponses = append(postResponses, resp)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	// Tag cloud (non-empty tags)
	cloud, _ := h.tagService.GetTagCloud(ctx, 20, publicOnly)

	// Hierarchical tags for nav (root tags with nested children)
	navTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly)

	// Public settings subset
	publicSettings := make(map[string]string)
	for k, v := range allSettings {
		if pagePublicSettingKeys[k] {
			publicSettings[k] = v
		}
	}

	// Apply min_tag_posts_to_show filter for public requests.
	if publicOnly {
		minPosts := getMinTagPostsSetting(allSettings)
		navTags = filterNavTagsByMinPosts(navTags, minPosts)
		if minPosts > 0 {
			filteredCloud := make([]services.TagCloudItem, 0, len(cloud))
			for _, item := range cloud {
				if item.Count >= minPosts {
					filteredCloud = append(filteredCloud, item)
				}
			}
			cloud = filteredCloud
		}
	}

	resp := map[string]interface{}{
		"posts":      postResponses,
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

	if publicOnly {
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

	// Try cache for public requests (TTL 15 minutes)
	cacheKey := fmt.Sprintf("tagpage_%s_p%d.json", slug, page)
	if publicOnly {
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

	// Direct children for tag detail response (exclude effectively hidden ones)
	allChildren, _ := h.tagService.GetTagChildren(ctx, tag.ID, publicOnly)
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
		childItems, _ = h.tagService.GetHierarchicalNavTags(ctx, &tag.ID, publicOnly)
	}

	// Root-level nav tags for global navigation
	rootNavTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly)

	// Apply min_tag_posts_to_show for public nav.
	if publicOnly {
		minPosts := getMinTagPostsSetting(allSettings)
		rootNavTags = filterNavTagsByMinPosts(rootNavTags, minPosts)
		childItems = filterNavTagsByMinPosts(childItems, minPosts)
	}

	// Posts for this tag (published only)
	posts, total, err := h.tagService.GetPostsByTag(ctx, tag.ID, int32(page), int32(perPage), publicOnly, false)
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

	postResponses := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		if publicOnly && !IsPostVisibleToPublic(tagPostTagsMap[p.ID], effectiveHiddenPostsTagIDs) {
			continue
		}
		resp := postToResponse(p, tagPostTagsMap[p.ID])
		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, p.Status, tagPostTagsMap[p.ID], effectiveHiddenPostsTagIDs)
		}
		postResponses = append(postResponses, resp)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	breadcrumbs := make([]map[string]interface{}, 0, len(ancestors))
	for _, a := range ancestors {
		if !effectivelyHidden[a.ID] && inBreadcrumbs[a.ID] {
			crumb := tagToListItem(a)
			if !publicOnly {
				crumb["is_hidden_posts"] = effectiveHiddenPostsTagIDs[a.ID]
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
	tagResp := tagToFullResponse(tag, parents, children, tagLoc)
	if !publicOnly {
		injectTagHiddenFields(tagResp, tag, effectiveHiddenPostsTagIDs)
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

	if publicOnly {
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

	tags, err := h.tagService.ListTags(ctx, false, publicOnly)
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
	effectiveHiddenPostsTagIDs, _ := h.tagService.EffectivelyHiddenPostsTagIDs(ctx)

	// Filter hidden tags for public view
	visible := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		if !publicOnly || !effectivelyHidden[t.ID] {
			parents, _ := h.tagService.GetTagParents(ctx, t.ID)
			allChildren, _ := h.tagService.GetTagChildren(ctx, t.ID, publicOnly)
			children := make([]models.Tag, 0, len(allChildren))
			for _, ch := range allChildren {
				if !publicOnly || !effectivelyHidden[ch.ID] {
					children = append(children, ch)
				}
			}
			var loc *models.TagLocation
			if l, ok := locMap[t.ID]; ok {
				loc = &l
			}
			tagResp := tagToFullResponse(t, parents, children, loc)
			if !publicOnly {
				injectTagHiddenFields(tagResp, t, effectiveHiddenPostsTagIDs)
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

	if publicOnly && mapSettings["enable_map"] == "false" {
		return echo.NewHTTPError(http.StatusNotFound, "map not found")
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

	effectivelyHiddenMap, _ := h.tagService.EffectivelyHiddenIDs(ctx)

	// Compute hierarchical post counts so that e.g. "Canada" reflects posts
	// tagged with any of its descendants (Montreal, etc.) even when not directly tagged.
	hierarchicalCounts, _ := h.tagService.GetHierarchicalPostCounts(ctx, publicOnly)

	mapTags := []map[string]interface{}{}
	for _, t := range allTags {
		if publicOnly && effectivelyHiddenMap[t.ID] {
			continue
		}
		loc, ok := locMap[t.ID]
		if !ok {
			continue
		}
		if minMapPosts > 0 {
			cnt := hierarchicalCounts[t.ID]
			if cnt == 0 {
				cnt = int64(t.PostCount)
			}
			if cnt < minMapPosts {
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

		postCount := hierarchicalCounts[t.ID]
		if postCount == 0 {
			postCount = int64(t.PostCount)
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

// filterNavTagsByMinPosts removes NavTagNode entries (and their subtrees) whose PostCount
// is below minPosts. Featured tags (is_featured) are always kept.
func filterNavTagsByMinPosts(nodes []services.NavTagNode, minPosts int64) []services.NavTagNode {
	if minPosts <= 0 {
		return nodes
	}
	result := make([]services.NavTagNode, 0, len(nodes))
	for _, n := range nodes {
		n.Children = filterNavTagsByMinPosts(n.Children, minPosts)
		if n.PostCount >= minPosts || n.IsRelated || len(n.Children) > 0 {
			result = append(result, n)
		}
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
