package api

import (
	"math"
	"net/http"
	"strconv"
	"strings"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type TagHandler struct {
	tagService      *services.TagService
	settingsService *services.SettingsService
}

func NewTagHandler(tagService *services.TagService, settingsService *services.SettingsService) *TagHandler {
	return &TagHandler{
		tagService:      tagService,
		settingsService: settingsService,
	}
}

func tagResponse(tag models.Tag, parents, children []models.Tag, loc *models.TagLocation, excludeIDs map[int64]bool) map[string]interface{} {
	return tagToFullResponse(tag, parents, children, loc, excludeIDs)
}

func (h *TagHandler) ListTags(c echo.Context) error {
	includeEmpty := c.QueryParam("include_empty") != "false"
	publicOnly := c.Get("user") == nil

	g, err := h.tagService.GetTagSnapshot(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Fetch locations for all tags.
	tagIDs := make([]int64, 0, len(g.ByID))
	for id := range g.ByID {
		tagIDs = append(tagIDs, id)
	}
	locationMap, _ := h.tagService.GetTagLocationsByTagIDs(c.Request().Context(), tagIDs)

	// Fetch min_tag_posts_to_show setting for guests.
	var minPosts int64
	if publicOnly {
		minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
		minPosts, _ = strconv.ParseInt(minPostsStr, 10, 64)
		if minPosts < 0 {
			minPosts = 0
		}
	}

	tagItems := make([]map[string]interface{}, 0)
	for id, t := range g.ByID {
		if publicOnly {
			if g.EffectiveHidden[id] {
				continue
			}
			if minPosts > 0 && g.CountsPublic[id] < minPosts {
				continue
			}
			if !includeEmpty && g.CountsPublic[id] == 0 {
				continue
			}
		} else {
			if !includeEmpty && g.CountsAdmin[id] == 0 {
				continue
			}
		}

		parents := make([]map[string]interface{}, 0)
		for _, pid := range g.Parents[id] {
			p := g.ByID[pid]
			parents = append(parents, map[string]interface{}{
				"id":   p.ID,
				"name": p.Name,
				"slug": p.Slug,
			})
		}

		children := make([]map[string]interface{}, 0)
		for _, cid := range g.Children[id] {
			ch := g.ByID[cid]
			children = append(children, map[string]interface{}{
				"id":   ch.ID,
				"name": ch.Name,
				"slug": ch.Slug,
			})
		}

		var loc *models.TagLocation
		if l, ok := locationMap[id]; ok {
			loc = &l
		}

		resp := map[string]interface{}{
			"id":                    t.ID,
			"name":                  t.Name,
			"slug":                  t.Slug,
			"description":           nullString(t.Description),
			"kind":                  t.Kind,
			"hidden":                t.Hidden,
			"hides_posts":           t.HidesPosts,
			"effective_hidden":      g.EffectiveHidden[id],
			"effective_hides_posts": g.EffectiveHidesPosts[id],
			"post_count":            g.CountsAdmin[id],
			"parents":               parents,
			"children":              children,
			"locations":             tagLocationsResponse(loc),
		}
		if publicOnly {
			resp["post_count"] = g.CountsPublic[id]
		} else {
			if via, ok := g.HiddenVia[id]; ok {
				resp["hidden_via"] = via
			}
		}
		tagItems = append(tagItems, resp)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"tags":  tagItems,
		"total": len(tagItems),
	})
}

func (h *TagHandler) GetTagCloud(c echo.Context) error {
	limit, _ := strconv.Atoi(c.QueryParam("limit"))
	if limit < 1 {
		limit = 20
	}
	publicOnly := c.Get("user") == nil

	// Fetch min_tag_posts_to_show threshold for guests.
	var minPosts int64
	if publicOnly {
		minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
		minPosts, _ = strconv.ParseInt(minPostsStr, 10, 64)
		if minPosts < 0 {
			minPosts = 0
		}
	}

	cloud, err := h.tagService.GetTagCloud(c.Request().Context(), limit, publicOnly, minPosts)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"tags": cloud})
}

func (h *TagHandler) GetTagByID(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	g, err := h.tagService.GetTagSnapshot(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	tag, ok := g.ByID[id]
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	return h.renderTagResponse(c, g, tag)
}

func (h *TagHandler) GetTagBySlug(c echo.Context) error {
	slug := c.Param("slug")
	g, err := h.tagService.GetTagSnapshot(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	tag, ok := g.BySlug[strings.ToLower(slug)]
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	return h.renderTagResponse(c, g, tag)
}

func (h *TagHandler) renderTagResponse(c echo.Context, g *services.TagGraph, tag models.Tag) error {
	publicOnly := c.Get("user") == nil
	var minPosts int64
	if publicOnly {
		minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
		minPosts, _ = strconv.ParseInt(minPostsStr, 10, 64)
		if minPosts < 0 {
			minPosts = 0
		}

		if g.EffectiveHidden[tag.ID] || (minPosts > 0 && g.CountsPublic[tag.ID] < minPosts) {
			return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
		}
	}

	parents := make([]models.Tag, 0)
	for _, pid := range g.Parents[tag.ID] {
		parents = append(parents, g.ByID[pid])
	}
	children := make([]models.Tag, 0)
	for _, cid := range g.Children[tag.ID] {
		if publicOnly {
			if g.EffectiveHidden[cid] {
				continue
			}
			if minPosts > 0 && g.CountsPublic[cid] < minPosts {
				continue
			}
		}
		children = append(children, g.ByID[cid])
	}

	loc := h.tagLocation(c, tag.ID)

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

	resp := tagToFullResponse(tag, parents, children, loc, excludeTagIDs)
	resp["effective_hidden"] = g.EffectiveHidden[tag.ID]
	resp["effective_hides_posts"] = g.EffectiveHidesPosts[tag.ID]
	resp["post_count"] = g.CountsAdmin[tag.ID]

	if publicOnly {
		resp["post_count"] = g.CountsPublic[tag.ID]
	} else {
		if via, ok := g.HiddenVia[tag.ID]; ok {
			resp["hidden_via"] = via
		}
	}

	return c.JSON(http.StatusOK, resp)
}

// tagLocation fetches the location for a single tag, returning nil if none.
func (h *TagHandler) tagLocation(c echo.Context, tagID int64) *models.TagLocation {
	locs, err := h.tagService.GetTagLocationsByTagIDs(c.Request().Context(), []int64{tagID})
	if err != nil {
		return nil
	}
	if l, ok := locs[tagID]; ok {
		return &l
	}
	return nil
}

type TagLocationInput struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type CreateTagRequest struct {
	Name             string             `json:"name"`
	Slug             string             `json:"slug"`
	Description      string             `json:"description"`
	Kind             string             `json:"kind"`
	Hidden           bool               `json:"hidden"`
	HidesPosts       bool               `json:"hides_posts"`
	NavOrder         *int64             `json:"nav_order"`
	InBreadcrumbs    bool               `json:"in_breadcrumbs"`
	ShowRelated      bool               `json:"show_related"`
	InAncestorFlyout bool               `json:"in_ancestor_flyout"`
	Latitude         *float64           `json:"latitude"`
	Longitude        *float64           `json:"longitude"`
	ParentIDs        []int64            `json:"parent_ids"`
	ChildIDs         []int64            `json:"child_ids"`
	Locations        []TagLocationInput `json:"locations"`
}

func (h *TagHandler) CreateTag(c echo.Context) error {
	var req CreateTagRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	tag, err := h.tagService.CreateTag(c.Request().Context(), services.CreateTagParams{
		Name:             req.Name,
		Slug:             req.Slug,
		Description:      req.Description,
		Kind:             req.Kind,
		Hidden:           req.Hidden,
		HidesPosts:       req.HidesPosts,
		NavOrder:         req.NavOrder,
		InBreadcrumbs:    req.InBreadcrumbs,
		ShowRelated:      req.ShowRelated,
		InAncestorFlyout: req.InAncestorFlyout,
		Latitude:         req.Latitude,
		Longitude:        req.Longitude,
		ParentIDs:        req.ParentIDs,
	})
	if err != nil {
		return err
	}

	_ = h.tagService.SetTagChildren(c.Request().Context(), tag.ID, req.ChildIDs)

	if len(req.Locations) > 0 {
		_ = h.tagService.UpsertTagLocation(c.Request().Context(), tag.ID, req.Locations[0].Latitude, req.Locations[0].Longitude)
	}

	g, _ := h.tagService.GetTagSnapshot(c.Request().Context())
	tag, _ = h.tagService.GetTagByID(c.Request().Context(), tag.ID)
	return h.renderTagResponseWithStatus(c, g, tag, http.StatusCreated)
}

func (h *TagHandler) UpdateTag(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	var req CreateTagRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	tag, err := h.tagService.UpdateTag(c.Request().Context(), services.UpdateTagParams{
		ID:               id,
		Name:             req.Name,
		Slug:             req.Slug,
		Description:      req.Description,
		Kind:             req.Kind,
		Hidden:           req.Hidden,
		HidesPosts:       req.HidesPosts,
		NavOrder:         req.NavOrder,
		InBreadcrumbs:    req.InBreadcrumbs,
		ShowRelated:      req.ShowRelated,
		InAncestorFlyout: req.InAncestorFlyout,
		Latitude:         req.Latitude,
		Longitude:        req.Longitude,
	})
	if err != nil {
		return err
	}

	// Always update parent, child, and location data (empty slice = remove all).
	_ = h.tagService.SetTagParents(c.Request().Context(), tag.ID, req.ParentIDs)
	_ = h.tagService.SetTagChildren(c.Request().Context(), tag.ID, req.ChildIDs)

	// Update location if provided
	if len(req.Locations) > 0 {
		_ = h.tagService.UpsertTagLocation(c.Request().Context(), tag.ID, req.Locations[0].Latitude, req.Locations[0].Longitude)
	}

	g, _ := h.tagService.GetTagSnapshot(c.Request().Context())
	tag, _ = h.tagService.GetTagByID(c.Request().Context(), tag.ID)
	return h.renderTagResponseWithStatus(c, g, tag, http.StatusOK)
}

func (h *TagHandler) renderTagResponseWithStatus(c echo.Context, g *services.TagGraph, tag models.Tag, status int) error {
	publicOnly := c.Get("user") == nil
	parents := make([]models.Tag, 0)
	for _, pid := range g.Parents[tag.ID] {
		parents = append(parents, g.ByID[pid])
	}
	children := make([]models.Tag, 0)
	for _, cid := range g.Children[tag.ID] {
		children = append(children, g.ByID[cid])
	}

	loc := h.tagLocation(c, tag.ID)

	excludeTagIDs := make(map[int64]bool)
	if publicOnly {
		for id := range g.EffectiveHidden {
			excludeTagIDs[id] = true
		}
	}

	resp := tagToFullResponse(tag, parents, children, loc, excludeTagIDs)
	resp["effective_hidden"] = g.EffectiveHidden[tag.ID]
	resp["effective_hides_posts"] = g.EffectiveHidesPosts[tag.ID]
	resp["post_count"] = g.CountsAdmin[tag.ID]

	if publicOnly {
		resp["post_count"] = g.CountsPublic[tag.ID]
	} else {
		if via, ok := g.HiddenVia[tag.ID]; ok {
			resp["hidden_via"] = via
		}
	}

	return c.JSON(status, resp)
}

func (h *TagHandler) DeleteTag(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	if err := h.tagService.DeleteTag(c.Request().Context(), id); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	return c.NoContent(http.StatusNoContent)
}

func toServiceLocations(in []TagLocationInput) []services.TagLocationInput {
	out := make([]services.TagLocationInput, len(in))
	for i, l := range in {
		out[i] = services.TagLocationInput{Latitude: l.Latitude, Longitude: l.Longitude}
	}
	return out
}

type ReorderTagRequest struct {
	TargetID *int64 `json:"target_id"`
	Position string `json:"position"` // "before" or "after"
	ParentID *int64 `json:"parent_id"`
}

func (h *TagHandler) ReorderTag(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid tag id")
	}
	var req ReorderTagRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	if err := h.tagService.ReorderTag(c.Request().Context(), services.ReorderTagParams{
		ID:       id,
		TargetID: req.TargetID,
		Position: req.Position,
		ParentID: req.ParentID,
	}); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

func (h *TagHandler) GeocodeTag(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid tag id")
	}
	lat, lon, err := h.tagService.GeocodeTag(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"latitude":  lat,
		"longitude": lon,
	})
}

func (h *TagHandler) RecalculateCounts(c echo.Context) error {
	if err := h.tagService.UpdateAllPostCounts(c.Request().Context()); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]string{"message": "Tag counts recalculated successfully"})
}

func (h *TagHandler) GetPostsByTag(c echo.Context) error {
	slug := c.Param("slug")
	g, err := h.tagService.GetTagSnapshot(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	tag, ok := g.BySlug[strings.ToLower(slug)]
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	perPageStr, _ := h.settingsService.GetSetting(c.Request().Context(), "posts_per_page", "10")
	defaultPerPage64, _ := strconv.ParseInt(perPageStr, 10, 32)
	defaultPerPage := int(defaultPerPage64)
	page, perPage := ParsePaginationParams(c, defaultPerPage)

	publicOnly := c.Get("user") == nil
	var minPosts int64
	if publicOnly {
		minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
		minPosts, _ = strconv.ParseInt(minPostsStr, 10, 64)
		if minPosts < 0 {
			minPosts = 0
		}

		if g.EffectiveHidden[tag.ID] || (minPosts > 0 && g.CountsPublic[tag.ID] < minPosts) {
			return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
		}

		if g.EffectiveHidesPosts[tag.ID] {
			return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
		}
	}

	posts, total, err := h.tagService.GetPostsByTag(c.Request().Context(), tag.ID, page, perPage, publicOnly, false, 0, 0)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	postIDs := make([]int64, len(posts))
	for i, p := range posts {
		postIDs[i] = p.ID
	}
	postTagsMap, _ := h.tagService.GetTagsByPostIDs(c.Request().Context(), postIDs)

	isAdmin := !publicOnly
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

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		resp := postToResponse(p, postTagsMap[p.ID], excludeTagIDs)
		if isAdmin {
			injectPostHiddenFieldsFromInfo(resp, p.Status, postTagsMap[p.ID], g.EffectiveHidesPosts)
		}
		postResponses[i] = resp
	}

	resp := map[string]interface{}{
		"id":          tag.ID,
		"name":        tag.Name,
		"slug":        tag.Slug,
		"description": nullString(tag.Description),
		"post_count":  g.CountsAdmin[tag.ID],
		"posts":       postResponses,
		"total_posts": total,
		"page":        page,
		"per_page":    perPage,
		"pages":       int(math.Ceil(float64(total) / float64(perPage))),
	}
	if publicOnly {
		resp["post_count"] = g.CountsPublic[tag.ID]
	}
	return c.JSON(http.StatusOK, resp)
}
