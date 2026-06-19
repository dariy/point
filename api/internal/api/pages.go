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
	"tags_module":            true,
	"tags_visibility":        true,
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

// splitPathParam parses the `path` query value ("a/b/c") into a slice of
// non-empty slugs, preserving order.
func splitPathParam(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, "/")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// tagPathHref builds a tag URL whose `path` query carries the given ancestor
// prefix (empty prefix → no query).
func tagPathHref(slug string, prefix []string) string {
	if len(prefix) == 0 {
		return "/tags/" + slug
	}
	return "/tags/" + slug + "?path=" + strings.Join(prefix, "/")
}

// resolveBreadcrumbPath validates that pathSlugs form a real connected
// parent→child chain in the tag graph whose last element is a parent of `tag`,
// and returns the resolved tags in order. Returns ok=false (caller falls back
// to the computed ancestor chain) when the path is empty, unknown, or broken.
func resolveBreadcrumbPath(snap *services.TagGraph, pathSlugs []string, tag models.Tag) ([]models.Tag, bool) {
	if snap == nil || len(pathSlugs) == 0 {
		return nil, false
	}
	isChild := func(parentID, childID int64) bool {
		for _, c := range snap.Children[parentID] {
			if c == childID {
				return true
			}
		}
		return false
	}
	resolved := make([]models.Tag, 0, len(pathSlugs))
	for i, s := range pathSlugs {
		t, ok := snap.BySlug[s]
		if !ok {
			return nil, false
		}
		if i > 0 && !isChild(resolved[i-1].ID, t.ID) {
			return nil, false
		}
		resolved = append(resolved, t)
	}
	// The last crumb must actually be a parent of the current tag.
	if !isChild(resolved[len(resolved)-1].ID, tag.ID) {
		return nil, false
	}
	return resolved, true
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

	// Explicit navigation path: the slug chain (root→…→immediate parent) the user
	// drilled through to reach this tag. Tags form a DAG, so this is the only way
	// to know which branch produced the breadcrumb the user expects to see.
	pathSlugs := splitPathParam(c.QueryParam("path"))

	// Try cache for public requests (TTL 15 minutes) — skip when year filter is active
	cacheKey := fmt.Sprintf("tagpage_%s_path-%s_p%d.json", slug, strings.Join(pathSlugs, "/"), page)
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

	// Build breadcrumbs. When the request carries a valid `path` (a real
	// root→…→parent chain in the tag graph that ends at a parent of this tag),
	// honour it verbatim so the crumb trail matches the branch the user
	// navigated. Otherwise fall back to the server-computed ancestor chain.
	var breadcrumbs []map[string]interface{}
	if pathTags, ok := resolveBreadcrumbPath(snap, pathSlugs, tag); ok {
		breadcrumbs = make([]map[string]interface{}, 0, len(pathTags))
		for i, a := range pathTags {
			if excludeTagIDs[a.ID] {
				continue
			}
			crumb := tagToListItem(a)
			// Each crumb links to itself carrying its own truncated path, so
			// clicking back up the trail preserves the navigated branch.
			crumb["href"] = tagPathHref(a.Slug, pathSlugs[:i])
			if !publicOnly {
				crumb["is_hidden_posts"] = effectiveHiddenPostsTagIDs[a.ID]
				crumb["is_hidden"] = effectivelyHidden[a.ID]
			}
			breadcrumbs = append(breadcrumbs, crumb)
		}
	} else {
		breadcrumbs = make([]map[string]interface{}, 0, len(ancestors))
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

// GetTagsGraph returns the data for the /tags force-graph view: tag nodes,
// post ("shadow") nodes, parent/child (hierarchy) edges, and post→tag
// (membership) edges. Anonymous viewers see only published posts and visible
// tags; authenticated users see everything.
func (h *PagesHandler) GetTagsGraph(c echo.Context) error {
	ctx := c.Request().Context()
	user := c.Get("user")
	publicOnly := user == nil

	allSettings, _ := h.settingsService.GetAllSettings(ctx)

	// The graph backs both the "tag cloud" and "atlas" modules served at /tags.
	if !tagsModuleAccessible(allSettings, []string{"cloud", "atlas"}, publicOnly) {
		return echo.NewHTTPError(http.StatusNotFound, "tags not found")
	}

	g, err := h.tagService.GetTagSnapshot(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	minPosts := getMinTagPostsSetting(allSettings)

	// Tags hidden from public viewers: effective-hidden + below min post count.
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

	// Tag nodes. kind + coordinates let the frontend classify year/geo nodes.
	tags := make([]map[string]interface{}, 0, len(g.ByID))
	for id, t := range g.ByID {
		if publicOnly && excludeTagIDs[id] {
			continue
		}
		node := map[string]interface{}{
			"id":   id,
			"name": t.Name,
			"slug": t.Slug,
			"kind": t.Kind,
		}
		if t.Latitude.Valid && t.Longitude.Valid {
			node["latitude"] = t.Latitude.Float64
			node["longitude"] = t.Longitude.Float64
		}
		if publicOnly {
			node["post_count"] = g.CountsPublic[id]
		} else {
			node["post_count"] = g.CountsAdmin[id]
		}
		tags = append(tags, node)
	}

	// Hierarchy edges (skip edges touching an excluded tag for public viewers).
	rels, err := h.tagService.GetAllTagRelationships(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	hierarchyEdges := make([]map[string]interface{}, 0, len(rels))
	for _, rel := range rels {
		if publicOnly && (excludeTagIDs[rel.ParentID] || excludeTagIDs[rel.ChildID]) {
			continue
		}
		hierarchyEdges = append(hierarchyEdges, map[string]interface{}{
			"parent": rel.ParentID,
			"child":  rel.ChildID,
		})
	}

	// Post nodes + membership edges.
	postNodes, err := h.repo.ListPostNodesForGraph(ctx, publicOnly)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	postIDs := make([]int64, len(postNodes))
	for i, p := range postNodes {
		postIDs[i] = p.ID
	}
	tagsByPost, err := h.tagService.GetTagsByPostIDs(ctx, postIDs)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	posts := make([]map[string]interface{}, 0, len(postNodes))
	membershipEdges := make([]map[string]interface{}, 0)
	for _, p := range postNodes {
		edges := 0
		for _, pt := range tagsByPost[p.ID] {
			if publicOnly && excludeTagIDs[pt.ID] {
				continue
			}
			membershipEdges = append(membershipEdges, map[string]interface{}{
				"post": p.ID,
				"tag":  pt.ID,
			})
			edges++
		}
		// Drop posts that connect to no visible tag (orphans under hidden tags).
		if edges == 0 {
			continue
		}
		node := map[string]interface{}{
			"id":    p.ID,
			"slug":  p.Slug,
			"title": p.Title,
		}
		// A single preview URL (thumbnail, else first image/video in content) so
		// image posts can render a thumbnail chip in the atlas cloud. Rewrite it
		// to the small square thumbnail variant — the cloud shows tiny chips, so
		// serving full-sized originals here is the source of the page's load.
		if mediaURL := extractMediaURL(p.ThumbnailPath, p.Content); mediaURL != nil {
			node["media_url"] = atlasThumbURL(*mediaURL)
		}
		posts = append(posts, node)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"tags":            tags,
		"posts":           posts,
		"hierarchyEdges":  hierarchyEdges,
		"membershipEdges": membershipEdges,
	})
}

// atlasThumbURL rewrites a preview media URL to request the small square
// thumbnail the atlas cloud chips display. Local media paths get a `?thumb=N`
// query (replacing any existing thumb marker, e.g. a post whose thumbnail_path
// already carries `?thumb`); external URLs are returned unchanged since the
// server can't resize media it doesn't host.
func atlasThumbURL(u string) string {
	if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	if i := strings.IndexByte(u, '?'); i >= 0 {
		u = u[:i]
	}
	return fmt.Sprintf("%s?thumb=%d", u, services.AtlasThumbSize)
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

	if !tagsModuleAccessible(mapSettings, []string{"map"}, publicOnly) {
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

// Default values for the consolidated "show tags" setting. A single module
// (tag cloud / map / atlas) is surfaced at /tags; tags_visibility controls
// whether the public sees it or only logged-in admins.
const (
	defaultTagsModule     = "atlas"
	defaultTagsVisibility = "hidden"
)

// tagsModuleAccessible reports whether the currently-selected tags module may be
// served for the given request. `want` lists the module values the calling
// endpoint can render (e.g. the graph endpoint backs both "cloud" and "atlas").
//
// Rules: "none" hides the feature from everyone. Otherwise admins always have
// access, while the public sees it only when tags_visibility is "all".
func tagsModuleAccessible(settings map[string]string, want []string, publicOnly bool) bool {
	module := getSettingOr(settings, "tags_module", defaultTagsModule)
	if module == "none" {
		return false
	}
	matched := false
	for _, w := range want {
		if w == module {
			matched = true
			break
		}
	}
	if !matched {
		return false
	}
	if publicOnly {
		return getSettingOr(settings, "tags_visibility", defaultTagsVisibility) == "all"
	}
	return true
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
