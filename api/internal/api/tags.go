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

	tags, err := h.tagService.ListTags(c.Request().Context(), includeEmpty, publicOnly)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Build tag map for parent lookups.
	tagMap := make(map[int64]models.Tag, len(tags))
	for _, t := range tags {
		tagMap[t.ID] = t
	}

	// Fetch all relationships; build parent and children maps for each tag.
	rels, _ := h.tagService.GetAllTagRelationships(c.Request().Context())
	childParents := make(map[int64][]map[string]interface{})
	parentChildren := make(map[int64][]map[string]interface{})
	for _, rel := range rels {
		if parent, ok := tagMap[rel.ParentID]; ok {
			childParents[rel.ChildID] = append(childParents[rel.ChildID], map[string]interface{}{
				"id":   parent.ID,
				"name": parent.Name,
				"slug": parent.Slug,
			})
		}
		if child, ok := tagMap[rel.ChildID]; ok {
			parentChildren[rel.ParentID] = append(parentChildren[rel.ParentID], map[string]interface{}{
				"id":   child.ID,
				"name": child.Name,
				"slug": child.Slug,
			})
		}
	}

	// For admin: non-system tags with no DB parents are virtually shown under _pending.
	// This is a presentation-layer computation only — no DB relationships are written.
	if !publicOnly {
		var pendingTag *models.Tag
		for i := range tags {
			if tags[i].Slug == "_pending" {
				pendingTag = &tags[i]
				break
			}
		}
		if pendingTag != nil {
			pendingRef := map[string]interface{}{
				"id":   pendingTag.ID,
				"name": pendingTag.Name,
				"slug": pendingTag.Slug,
			}
			for _, t := range tags {
				if strings.HasPrefix(t.Slug, "_") {
					continue // system tags have fixed parentage
				}
				if len(childParents[t.ID]) == 0 {
					childParents[t.ID] = []map[string]interface{}{pendingRef}
					parentChildren[pendingTag.ID] = append(parentChildren[pendingTag.ID], map[string]interface{}{
						"id":   t.ID,
						"name": t.Name,
						"slug": t.Slug,
					})
				}
			}
		}
	}

	// Fetch locations for all tags.
	tagIDs := make([]int64, len(tags))
	for i, t := range tags {
		tagIDs[i] = t.ID
	}
	locationMap, _ := h.tagService.GetTagLocationsByTagIDs(c.Request().Context(), tagIDs)

	// Fetch hierarchical post counts (tag + all descendants).
	// publishedOnly=true for public users, false for admin (includes hidden-status posts).
	effectiveCounts, _ := h.tagService.GetHierarchicalPostCounts(c.Request().Context(), publicOnly)

	// Fetch min_tag_posts_to_show setting for guests.
	var minPosts int64
	if publicOnly {
		minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
		minPosts, _ = strconv.ParseInt(minPostsStr, 10, 64)
		if minPosts < 0 {
			minPosts = 0
		}
	}

	tagItems := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		// Apply threshold filter for guests.
		if publicOnly && minPosts > 0 && effectiveCounts[t.ID] < minPosts {
			continue
		}

		parents := childParents[t.ID]
		if parents == nil {
			parents = []map[string]interface{}{}
		}
		children := parentChildren[t.ID]
		if children == nil {
			children = []map[string]interface{}{}
		}
		var loc *models.TagLocation
		if l, ok := locationMap[t.ID]; ok {
			loc = &l
		}
		tagItems = append(tagItems, map[string]interface{}{
			"id":          t.ID,
			"name":        t.Name,
			"slug":        t.Slug,
			"description": nullString(t.Description),
			"custom_url":  nullString(t.CustomUrl),
			"sort_order":  nullInt64(t.SortOrder),
			"post_count":  effectiveCounts[t.ID],
			"is_system":   strings.HasPrefix(t.Slug, "_"),
			"parents":     parents,
			"children":    children,
			"locations":   tagLocationsResponse(loc),
		})
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

	tag, err := h.tagService.GetTagByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	publicOnly := c.Get("user") == nil
	var minPosts int64
	if publicOnly {
		minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
		minPosts, _ = strconv.ParseInt(minPostsStr, 10, 64)
		if minPosts < 0 {
			minPosts = 0
		}

		effectivelyHidden, _ := h.tagService.EffectivelyHiddenIDs(c.Request().Context())
		effectiveCounts, _ := h.tagService.GetHierarchicalPostCounts(c.Request().Context(), publicOnly)

		if effectivelyHidden[tag.ID] || (minPosts > 0 && effectiveCounts[tag.ID] < minPosts) {
			return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
		}
	}

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID, publicOnly, minPosts)
	loc := h.tagLocation(c, tag.ID)

	excludeTagIDs, _ := h.tagService.PublicHiddenTagIDs(c.Request().Context(), minPosts)
	resp := tagResponse(tag, parents, children, loc, excludeTagIDs)
	if !publicOnly {
		effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(c.Request().Context())
		injectTagHiddenFields(resp, tag, effectiveHiddenPosts)
	}
	return c.JSON(http.StatusOK, resp)
}

func (h *TagHandler) GetTagBySlug(c echo.Context) error {
	slug := c.Param("slug")
	tag, err := h.tagService.GetTagBySlug(c.Request().Context(), slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	publicOnly := c.Get("user") == nil
	var minPosts int64
	if publicOnly {
		minPostsStr, _ := h.settingsService.GetSetting(c.Request().Context(), "min_tag_posts_to_show", "0")
		minPosts, _ = strconv.ParseInt(minPostsStr, 10, 64)
		if minPosts < 0 {
			minPosts = 0
		}

		effectivelyHidden, _ := h.tagService.EffectivelyHiddenIDs(c.Request().Context())
		effectiveCounts, _ := h.tagService.GetHierarchicalPostCounts(c.Request().Context(), publicOnly)

		if effectivelyHidden[tag.ID] || (minPosts > 0 && effectiveCounts[tag.ID] < minPosts) {
			return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
		}
	}

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID, publicOnly, minPosts)
	loc := h.tagLocation(c, tag.ID)

	excludeTagIDs, _ := h.tagService.PublicHiddenTagIDs(c.Request().Context(), minPosts)
	resp := tagResponse(tag, parents, children, loc, excludeTagIDs)
	if !publicOnly {
		effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(c.Request().Context())
		injectTagHiddenFields(resp, tag, effectiveHiddenPosts)
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
	Name        string             `json:"name"`
	Slug        string             `json:"slug"`
	Description string             `json:"description"`
	CustomURL   string             `json:"custom_url"`
	SortOrder   *int32             `json:"sort_order"`
	ParentIDs   []int64            `json:"parent_ids"`
	ChildIDs    []int64            `json:"child_ids"`
	Locations   []TagLocationInput `json:"locations"`
}

func (h *TagHandler) CreateTag(c echo.Context) error {
	var req CreateTagRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	tag, err := h.tagService.CreateTag(c.Request().Context(), services.CreateTagParams{
		Name:        req.Name,
		Slug:        req.Slug,
		Description: req.Description,
		CustomURL:   req.CustomURL,
		SortOrder:   req.SortOrder,
		ParentIDs:   req.ParentIDs,
	})
	if err != nil {
		return err
	}

	_ = h.tagService.SetTagChildren(c.Request().Context(), tag.ID, req.ChildIDs)
	_ = h.tagService.SetTagLocations(c.Request().Context(), tag.ID, toServiceLocations(req.Locations))

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID, false, 0)
	loc := h.tagLocation(c, tag.ID)

	excludeTagIDs, _ := h.tagService.PublicHiddenTagIDs(c.Request().Context(), 0)
	resp := tagResponse(tag, parents, children, loc, excludeTagIDs)
	effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(c.Request().Context())
	injectTagHiddenFields(resp, tag, effectiveHiddenPosts)
	return c.JSON(http.StatusCreated, resp)
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
		ID:          id,
		Name:        req.Name,
		Slug:        req.Slug,
		Description: req.Description,
		CustomURL:   req.CustomURL,
		SortOrder:   req.SortOrder,
	})
	if err != nil {
		return err
	}

	// Always update parent, child, and location data (empty slice = remove all).
	_ = h.tagService.SetTagParents(c.Request().Context(), tag.ID, req.ParentIDs)
	_ = h.tagService.SetTagChildren(c.Request().Context(), tag.ID, req.ChildIDs)
	_ = h.tagService.SetTagLocations(c.Request().Context(), tag.ID, toServiceLocations(req.Locations))

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID, false, 0)
	loc := h.tagLocation(c, tag.ID)

	excludeTagIDs, _ := h.tagService.PublicHiddenTagIDs(c.Request().Context(), 0)
	resp := tagResponse(tag, parents, children, loc, excludeTagIDs)
	effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(c.Request().Context())
	injectTagHiddenFields(resp, tag, effectiveHiddenPosts)
	return c.JSON(http.StatusOK, resp)
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
	tag, err := h.tagService.GetTagBySlug(c.Request().Context(), slug)
	if err != nil {
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

		effectivelyHidden, _ := h.tagService.EffectivelyHiddenIDs(c.Request().Context())
		effectiveCounts, _ := h.tagService.GetHierarchicalPostCounts(c.Request().Context(), publicOnly)

		if effectivelyHidden[tag.ID] || (minPosts > 0 && effectiveCounts[tag.ID] < minPosts) {
			return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
		}

		effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(c.Request().Context())
		if effectiveHiddenPosts[tag.ID] {
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
	effectiveHiddenPosts, _ := h.tagService.EffectivelyHiddenPostsTagIDs(c.Request().Context())
	excludeTagIDs, _ := h.tagService.PublicHiddenTagIDs(c.Request().Context(), minPosts)
	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		resp := postToResponse(p, postTagsMap[p.ID], excludeTagIDs)
		if isAdmin {
			injectPostHiddenFieldsFromInfo(resp, p.Status, postTagsMap[p.ID], effectiveHiddenPosts)
		}
		postResponses[i] = resp
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":          tag.ID,
		"name":        tag.Name,
		"slug":        tag.Slug,
		"description": nullString(tag.Description),
		"post_count":  tag.PostCount,
		"posts":       postResponses,
		"total_posts": total,
		"page":        page,
		"per_page":    perPage,
		"pages":       int(math.Ceil(float64(total) / float64(perPage))),
	})
}
