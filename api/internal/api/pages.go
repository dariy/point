package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"point-api/internal/repository"
	"point-api/internal/services"
	"point-api/internal/services/pageview"

	"github.com/labstack/echo/v4"
)

// PagesHandler serves the BFF page endpoints: one aggregate per screen the SPA
// renders. Composing those aggregates is pageview's job; what stays here is the
// HTTP half — reading the request, deciding whether the answer can be cached,
// and turning a view into the JSON shape the frontend is coded against.
type PagesHandler struct {
	tagService      *services.TagService
	settingsService *services.SettingsService
	cacheService    *services.CacheService
	pages           *pageview.Builder
}

func NewPagesHandler(repo repository.Repository, postService *services.PostService, tagService *services.TagService, mediaService *services.MediaService, settingsService *services.SettingsService, cacheService *services.CacheService) *PagesHandler {
	return &PagesHandler{
		tagService:      tagService,
		settingsService: settingsService,
		cacheService:    cacheService,
		pages:           pageview.New(repo, postService, tagService, mediaService),
	}
}

// viewError turns a builder's error into the response. pageview's "this viewer
// may not have it" becomes the 404 the calling endpoint has always answered
// with — the wording differs per endpoint, so it is passed in. Everything else
// goes through MapError, which is what decides a status from the service error
// taxonomy.
func viewError(err error, notFoundMessage string) error {
	if errors.Is(err, pageview.ErrNotVisible) {
		return echo.NewHTTPError(http.StatusNotFound, notFoundMessage)
	}
	return MapError(err)
}

// feedParams reads the pagination and timeline scope a feed endpoint takes.
// perPage is bounded here rather than in pageview, because the ceiling is a
// property of what this handler is willing to render and cache, not of the
// view being built.
func feedParams(c echo.Context, settings map[string]string, publicOnly bool) pageview.FeedParams {
	defaultPerPage64, _ := strconv.ParseInt(pageview.SettingOr(settings, "posts_per_page", "10"), 10, 32)
	defaultPerPage := int(defaultPerPage64)
	page, perPage := ParsePaginationParams(c, defaultPerPage)

	p := pageview.FeedParams{
		PublicOnly: publicOnly,
		Page:       page,
		PerPage:    clampGridPageSize(perPage),
	}
	// ParsePaginationParams has already clamped a non-positive page away, so the
	// raw value is read back for the one caller that needs it: the scheduled
	// queue lives at page 0 and below.
	if raw, err := strconv.ParseInt(c.QueryParam("page"), 10, 32); err == nil {
		p.RawPage, p.RawPageOK = int32(raw), true
	}
	p.YearFrom, _ = strconv.Atoi(c.QueryParam("year_from"))
	p.YearTo, _ = strconv.Atoi(c.QueryParam("year_to"))
	return p
}

// GetHomePage returns all data needed to render the public homepage.
func (h *PagesHandler) GetHomePage(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	settings, _ := h.settingsService.GetAllSettings(ctx)
	params := feedParams(c, settings, publicOnly)

	// per_page is part of the key: it's device-fit / pinch-zoom controlled, so the
	// same page at a different post count must not serve a stale-sized blob. It
	// has been capped at maxGridPageSize, which is what bounds how many distinct
	// entries one page number can spread across.
	cacheKey := pageCacheKey("homepage", fmt.Sprintf("p%d_pp%d", params.Page, params.PerPage))
	// An owner's feed carries drafts, hidden posts and the scheduled queue, and a
	// timeline scope is a long tail of one-off ranges. Neither is shared between
	// visitors, so neither earns an entry.
	cacheable := publicOnly && !params.HasYearFilter()

	render := func(ctx context.Context) ([]byte, error) {
		view, err := h.pages.BuildHomeView(ctx, settings, params)
		if err != nil {
			return nil, MapError(err)
		}
		return json.Marshal(homeResponse(view, publicOnly))
	}

	return servePageJSON(c, h.cacheService, cacheKey, cacheable, render)
}

// homeResponse renders a home view as the homepage payload.
func homeResponse(v *pageview.HomeView, publicOnly bool) map[string]interface{} {
	if cp := v.CustomPage; cp != nil {
		resp := postToResponse(cp.Post, cp.Tags, v.Visibility.ExcludeTagIDs)
		resp["type"] = "page" // pageview only pins a post whose type is already page
		if !v.ShowViewCounts {
			delete(resp, "view_count")
		}
		resp["content_html"] = injectArticleSrcset(cp.ContentHTML, cp.Media, cp.ThumbnailGeneration)

		media := make([]map[string]interface{}, 0, len(cp.Media))
		for _, m := range cp.Media {
			media = append(media, map[string]interface{}{
				"path":     "/" + strings.TrimPrefix(m.OriginalPath, "originals/"),
				"alt_text": nullString(m.AltText),
			})
		}
		resp["media"] = media

		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, cp.Post.Status, cp.Tags, v.Visibility.EffectiveHiddenPosts)
		}

		return map[string]interface{}{
			"posts": []map[string]interface{}{resp},
			"pagination": map[string]interface{}{
				"page":     1,
				"per_page": 1,
				"total":    1,
				"pages":    1,
			},
			"settings": v.Settings,
		}
	}

	resp := map[string]interface{}{
		"posts":      postList(v.Posts, v.Visibility, publicOnly, v.ShowViewCounts),
		"pagination": paginationResponse(v.Pagination),
		"settings":   v.Settings,
	}
	if v.Nav != nil {
		resp["tag_cloud"] = v.Nav.TagCloud
		resp["menu"] = v.Nav.Menu
	}
	return resp
}

// GetTagPage returns all data needed to render a tag archive page.
func (h *PagesHandler) GetTagPage(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	settings, _ := h.settingsService.GetAllSettings(ctx)
	params := pageview.TagParams{
		FeedParams: feedParams(c, settings, publicOnly),
		Slug:       c.Param("slug"),
		Path:       pageview.SplitPathParam(c.QueryParam("path")),
	}

	// per_page is part of the key (device-fit / pinch-zoom controlled, capped at
	// maxGridPageSize) so the same page at a different post count isn't served a
	// stale-sized cached blob.
	cacheKey := pageCacheKey("tagpage", fmt.Sprintf("%s_path-%s_p%d_pp%d",
		params.Slug, strings.Join(params.Path, "/"), params.Page, params.PerPage))
	// As on the home feed: an owner's archive and a timeline scope are not shared
	// between visitors, so neither is cached.
	cacheable := publicOnly && !params.HasYearFilter()

	render := func(ctx context.Context) ([]byte, error) {
		view, err := h.pages.BuildTagView(ctx, settings, params)
		if err != nil {
			return nil, viewError(err, "Tag not found")
		}
		return json.Marshal(tagResponse(view, publicOnly))
	}

	return servePageJSON(c, h.cacheService, cacheKey, cacheable, render)
}

// tagResponse renders a tag view as the tag-archive payload.
func tagResponse(v *pageview.TagView, publicOnly bool) map[string]interface{} {
	vis := v.Visibility

	tag := tagToFullResponse(v.Tag, v.Parents, v.Children, v.Location, vis.ExcludeTagIDs)
	if !publicOnly {
		injectTagHiddenFields(tag, v.Tag, vis.EffectiveHiddenPosts)
		tag["is_hidden"] = vis.EffectiveHidden[v.Tag.ID]
	}

	breadcrumbs := make([]map[string]interface{}, 0, len(v.Breadcrumbs))
	for _, crumb := range v.Breadcrumbs {
		item := tagToListItem(crumb.Tag)
		if crumb.Href != "" {
			item["href"] = crumb.Href
		}
		if !publicOnly {
			item["is_hidden_posts"] = vis.EffectiveHiddenPosts[crumb.Tag.ID]
			item["is_hidden"] = vis.EffectiveHidden[crumb.Tag.ID]
		}
		breadcrumbs = append(breadcrumbs, item)
	}

	return map[string]interface{}{
		"tag":          tag,
		"breadcrumbs":  breadcrumbs,
		"posts":        postList(v.Posts, vis, publicOnly, v.ShowViewCounts),
		"menu":         v.Menu,
		"nav_children": v.NavChildren,
		"pagination":   paginationResponse(v.Pagination),
	}
}

// postList renders the post entries of a feed view.
func postList(entries []pageview.PostEntry, vis pageview.Visibility, publicOnly, showViewCounts bool) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(entries))
	for _, e := range entries {
		resp := postToListResponse(e.Post, e.Tags, vis.ExcludeTagIDs)
		if !publicOnly {
			injectPostHiddenFieldsFromInfo(resp, e.Post.Status, e.Tags, vis.EffectiveHiddenPosts)
		}
		if !showViewCounts {
			delete(resp, "view_count")
		}
		out = append(out, resp)
	}
	return out
}

// paginationResponse renders a paginator. min_page says how far left the feed
// extends — 1 for everyone but an owner with a non-empty scheduled queue, for
// whom it drops to 0 or below — and scheduled says which half the page being
// returned came from.
func paginationResponse(p pageview.Pagination) map[string]interface{} {
	return map[string]interface{}{
		"page":      p.Page,
		"per_page":  p.PerPage,
		"total":     p.Total,
		"pages":     p.Pages,
		"min_page":  p.MinPage,
		"scheduled": p.Scheduled,
	}
}

// GetTagsPage returns data for the tags directory page.
func (h *PagesHandler) GetTagsPage(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	settings, _ := h.settingsService.GetAllSettings(ctx)
	view, err := h.pages.BuildDirectoryView(ctx, settings, pageview.DirectoryParams{PublicOnly: publicOnly})
	if err != nil {
		return MapError(err)
	}

	tags := make([]map[string]interface{}, 0, len(view.Tags))
	for _, t := range view.Tags {
		resp := tagToFullResponse(t.Tag, t.Parents, t.Children, t.Location, view.ExcludeTagIDs)
		resp["effective_hidden"] = t.EffectiveHidden
		resp["effective_hides_posts"] = t.EffectiveHidesPosts
		resp["post_count"] = t.PostCount
		if !publicOnly {
			resp["is_hidden"] = t.EffectiveHidden
			if t.HiddenVia != nil {
				resp["hidden_via"] = *t.HiddenVia
			}
		}
		tags = append(tags, resp)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"tags":  tags,
		"total": len(tags),
	})
}

// GetTagsGraph returns the data for the /tags force-graph view: tag nodes,
// post ("shadow") nodes, parent/child (hierarchy) edges, and post→tag
// (membership) edges.
func (h *PagesHandler) GetTagsGraph(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	settings, _ := h.settingsService.GetAllSettings(ctx)
	yearFrom, yearTo, hasYearRange := parseYearRangeParams(c)

	view, err := h.pages.BuildGraphView(ctx, settings, pageview.GraphParams{
		PublicOnly:   publicOnly,
		YearFrom:     yearFrom,
		YearTo:       yearTo,
		HasYearRange: hasYearRange,
		// The atlas opts out with ?posts=0 to avoid shipping the whole post set
		// up front; it fetches each place's recent posts on tap instead.
		IncludePosts: c.QueryParam("posts") != "0",
	})
	if err != nil {
		return viewError(err, "tags not found")
	}

	resp := map[string]interface{}{
		"tags":           graphTagNodes(view.Tags, true),
		"hierarchyEdges": hierarchyEdges(view.HierarchyEdges),
	}
	if view.IncludePosts {
		resp["posts"] = graphPostNodes(view.Posts)
		resp["membershipEdges"] = membershipEdges(view.MembershipEdges)
	}
	return c.JSON(http.StatusOK, resp)
}

// GetTagCloud returns the on-tap cloud for a single place (a geo-tag) on the
// Atlas: the place's sub-tree's most recent posts and most popular co-occurring
// tags, plus the edges connecting that subset, so the frontend can render the
// cloud without loading the whole graph. Accepts optional year_from/year_to to
// scope posts to a timeline range.
func (h *PagesHandler) GetTagCloud(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	tagID, err := parseNamedIDParam(c, "tag id")
	if err != nil {
		return err
	}

	settings, _ := h.settingsService.GetAllSettings(ctx)
	// Looser than parseYearRangeParams: the cloud accepts any ordered pair it is
	// given, and falls back to the unscoped query for anything else.
	from, errF := strconv.Atoi(c.QueryParam("year_from"))
	to, errT := strconv.Atoi(c.QueryParam("year_to"))
	hasYearRange := c.QueryParam("year_from") != "" && c.QueryParam("year_to") != "" &&
		errF == nil && errT == nil && from <= to

	view, err := h.pages.BuildCloudView(ctx, settings, pageview.CloudParams{
		PublicOnly:   publicOnly,
		TagID:        tagID,
		YearFrom:     from,
		YearTo:       to,
		HasYearRange: hasYearRange,
	})
	if err != nil {
		return viewError(err, "tag not found")
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"tags":            graphTagNodes(view.Tags, false),
		"posts":           graphPostNodes(view.Posts),
		"membershipEdges": membershipEdges(view.MembershipEdges),
		"hierarchyEdges":  hierarchyEdges(view.HierarchyEdges),
	})
}

// graphTagNodes renders the tag nodes of a graph payload. Coordinates and
// is_hidden are emitted only when they apply — absent reads as falsy, the
// frontend contract in docs/features/hidden-visibility.md, and this payload
// carries every tag on the site. withCounts is false for the atlas cloud, whose
// chips carry no post counts.
func graphTagNodes(tags []pageview.TagNode, withCounts bool) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		node := map[string]interface{}{
			"id":   t.ID,
			"name": t.Name,
			"slug": t.Slug,
			"kind": t.Kind,
		}
		if t.Latitude != nil && t.Longitude != nil {
			node["latitude"] = *t.Latitude
			node["longitude"] = *t.Longitude
		}
		if t.IsHidden {
			node["is_hidden"] = true
		}
		if withCounts {
			node["post_count"] = t.PostCount
		}
		out = append(out, node)
	}
	return out
}

// graphPostNodes renders the post shadow-nodes of a graph payload.
func graphPostNodes(posts []pageview.PostNode) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(posts))
	for _, p := range posts {
		node := map[string]interface{}{"id": p.ID, "slug": p.Slug, "title": p.Title}
		if p.MediaURL != "" {
			node["media_url"] = p.MediaURL
		}
		if p.Status != "" {
			node["status"] = p.Status
		}
		out = append(out, node)
	}
	return out
}

func hierarchyEdges(edges []pageview.HierarchyEdge) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(edges))
	for _, e := range edges {
		out = append(out, map[string]interface{}{"parent": e.Parent, "child": e.Child})
	}
	return out
}

func membershipEdges(edges []pageview.MembershipEdge) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(edges))
	for _, e := range edges {
		out = append(out, map[string]interface{}{"post": e.Post, "tag": e.Tag})
	}
	return out
}

// GetMapPage returns all tags that have coordinates, categorised by type
// (country / city / other) for the public /map page.
func (h *PagesHandler) GetMapPage(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	settings, _ := h.settingsService.GetAllSettings(ctx)
	// Looser than parseYearRangeParams, as on the cloud: any ordered pair scopes
	// the markers, anything else shows them all.
	from, errF := strconv.Atoi(c.QueryParam("year_from"))
	to, errT := strconv.Atoi(c.QueryParam("year_to"))
	hasYearRange := c.QueryParam("year_from") != "" && c.QueryParam("year_to") != "" &&
		errF == nil && errT == nil && from <= to

	view, err := h.pages.BuildMapView(ctx, settings, pageview.MapParams{
		PublicOnly:   publicOnly,
		YearFrom:     from,
		YearTo:       to,
		HasYearRange: hasYearRange,
	})
	if err != nil {
		return viewError(err, "map not found")
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"tags": mapMarkers(view.Places, publicOnly)})
}

// mapMarkers renders the /map payload. is_hidden and hidden_via are owner-only:
// a guest is never sent a hidden place to begin with.
func mapMarkers(places []pageview.MapPlace, publicOnly bool) []map[string]interface{} {
	out := []map[string]interface{}{}
	for _, place := range places {
		entry := map[string]interface{}{
			"name":       place.Name,
			"slug":       place.Slug,
			"post_count": place.PostCount,
			"lat":        place.Latitude,
			"lng":        place.Longitude,
			"type":       place.Type,
			"years":      place.Years,
		}
		if !publicOnly {
			entry["is_hidden"] = place.IsHidden
			if place.HiddenVia != nil {
				entry["hidden_via"] = *place.HiddenVia
			}
		}
		out = append(out, entry)
	}
	return out
}

// parseYearRangeParams reads the timeline scope the public views send as
// `year_from`/`year_to`. ok is false unless both parse to a sane, ordered pair,
// which callers read as "no scope" — a malformed range widens to everything
// rather than filtering to nothing.
func parseYearRangeParams(c echo.Context) (from, to int, ok bool) {
	from, errFrom := strconv.Atoi(c.QueryParam("year_from"))
	to, errTo := strconv.Atoi(c.QueryParam("year_to"))
	if errFrom != nil || errTo != nil || from <= 0 || to <= 0 || from > to {
		return 0, 0, false
	}
	return from, to, true
}

// GetNavMenu returns the hierarchical tag tree (or custom menu) for navigation,
// scoped to the current user's auth level.
//
// Response: {"menu": [...], "tags": [...]}. `menu` is the nav zone's list —
// whatever `nav_menu_mode` selects. `tags` is the root tag tree behind the
// site-title dropdown, and is only sent in "custom" mode, where the menu shows
// authored links and the dropdown becomes the one surface still exposing the
// tag tree. In "tags" mode the menu *is* that tree (the client falls back to
// `menu`); in "none" mode the site is deliberately menuless, so neither the
// menu nor the title offers tags.
// GET /api/pages/nav
func (h *PagesHandler) GetNavMenu(c echo.Context) error {
	ctx := c.Request().Context()
	publicOnly := c.Get("user") == nil

	allSettings, _ := h.settingsService.GetAllSettings(ctx)

	// Mode "none": the site runs without a menu (identity + crumbs + tools).
	if allSettings["nav_menu_mode"] == "none" {
		return c.JSON(http.StatusOK, map[string]interface{}{"menu": []services.NavTagNode{}})
	}

	minPosts := int64(0)
	if publicOnly {
		minPosts = pageview.MinTagPostsSetting(allSettings)
	}

	if allSettings["nav_menu_mode"] == "custom" {
		menu := []services.NavTagNode{}
		if raw := allSettings["custom_nav_menu"]; raw != "" {
			var nodes []services.NavTagNode
			if err := json.Unmarshal([]byte(raw), &nodes); err == nil && nodes != nil {
				menu = nodes
			}
		}
		rootTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly, minPosts)
		if rootTags == nil {
			rootTags = []services.NavTagNode{}
		}
		return c.JSON(http.StatusOK, map[string]interface{}{"menu": menu, "tags": rootTags})
	}

	navTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly, minPosts)
	return c.JSON(http.StatusOK, map[string]interface{}{"menu": navTags})
}
