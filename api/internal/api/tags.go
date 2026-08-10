package api

// HTTP handlers for /api/tags. Each one parses its arguments, calls the tag
// service and renders through a tagView; the visibility rules and payload
// shaping live in tags_view.go, the partial-update decoding in tags_patch.go.

import (
	"context"
	"encoding/json"
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

func (h *TagHandler) ListTags(c echo.Context) error {
	includeEmpty := c.QueryParam("include_empty") != "false"
	searchQuery := strings.ToLower(strings.TrimSpace(c.QueryParam("q")))

	v, err := h.tagView(c)
	if err != nil {
		return err
	}

	tagIDs := make([]int64, 0, len(v.g.ByID))
	for id := range v.g.ByID {
		tagIDs = append(tagIDs, id)
	}
	locations, _ := h.tagService.GetTagLocationsByTagIDs(c.Request().Context(), tagIDs)

	tagItems := make([]map[string]interface{}, 0)
	for id, t := range v.g.ByID {
		if searchQuery != "" &&
			!strings.Contains(strings.ToLower(t.Name), searchQuery) &&
			!strings.Contains(strings.ToLower(t.Slug), searchQuery) {
			continue
		}
		if v.hidden(id) {
			continue
		}
		if !includeEmpty && v.count(id) == 0 {
			continue
		}

		var loc *models.TagLocation
		if l, ok := locations[id]; ok {
			loc = &l
		}
		tagItems = append(tagItems, v.listItem(t, loc))
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

	cloud, err := h.tagService.GetTagCloud(c.Request().Context(), limit, publicOnly,
		h.minTagPosts(c.Request().Context(), publicOnly))
	if err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{"tags": cloud})
}

func (h *TagHandler) GetTagByID(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	v, err := h.tagView(c)
	if err != nil {
		return err
	}
	tag, ok := v.g.ByID[id]
	if !ok || v.hidden(id) {
		return tagNotFound()
	}

	return h.renderTag(c, v, tag, http.StatusOK)
}

func (h *TagHandler) GetTagBySlug(c echo.Context) error {
	v, err := h.tagView(c)
	if err != nil {
		return err
	}
	tag, ok := v.g.BySlug[strings.ToLower(c.Param("slug"))]
	if !ok || v.hidden(tag.ID) {
		return tagNotFound()
	}

	return h.renderTag(c, v, tag, http.StatusOK)
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
		return badTagRequest()
	}

	ctx := c.Request().Context()
	tag, err := h.tagService.CreateTag(ctx, services.CreateTagParams{
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
		return MapError(err)
	}

	// Children and locations are separate writes; the tag itself is already
	// saved, so a failure here must not fail the create.
	_ = h.tagService.SetTagChildren(ctx, tag.ID, req.ChildIDs)
	if len(req.Locations) > 0 {
		_ = h.tagService.UpsertTagLocation(ctx, tag.ID, req.Locations[0].Latitude, req.Locations[0].Longitude)
	}

	return h.renderSavedTag(c, tag.ID, http.StatusCreated)
}

// UpdateTag handles PUT /api/tags/:id: a partial update of the tag's own
// fields plus its relationships and location.
func (h *TagHandler) UpdateTag(c echo.Context) error {
	return h.applyTagPatch(c, true)
}

// PatchTag handles PATCH /api/tags/:id: a partial update of the tag's scalar
// fields only. Relationship keys in the body are ignored — the dedicated
// parents/children endpoints own those.
func (h *TagHandler) PatchTag(c echo.Context) error {
	return h.applyTagPatch(c, false)
}

// applyTagPatch is the shared body of PUT and PATCH. Only fields present in
// the JSON body are changed; absent fields keep their current values, and for
// parent_ids/child_ids an explicit empty array removes all relationships while
// an omitted key leaves them untouched.
func (h *TagHandler) applyTagPatch(c echo.Context, withRelations bool) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	v, err := h.tagView(c)
	if err != nil {
		return err
	}
	current, ok := v.g.ByID[id]
	if !ok {
		return tagNotFound()
	}

	var fields map[string]json.RawMessage
	if err := json.NewDecoder(c.Request().Body).Decode(&fields); err != nil {
		return badTagRequest()
	}

	tag, err := h.tagService.UpdateTag(c.Request().Context(), tagPatchParams(current, fields))
	if err != nil {
		return MapError(err)
	}

	if withRelations {
		h.applyTagRelations(c, tag.ID, fields)
	}

	return h.renderSavedTag(c, tag.ID, http.StatusOK)
}

// applyTagRelations applies the parent_ids/child_ids/locations keys of a PUT
// body. Each is best-effort: the tag's own fields are already saved, so a
// malformed or failing relationship write leaves that relationship as it was
// rather than failing the whole request.
func (h *TagHandler) applyTagRelations(c echo.Context, id int64, fields map[string]json.RawMessage) {
	ctx := c.Request().Context()

	if ids, ok := patchIDList(fields, "parent_ids"); ok {
		_ = h.tagService.SetTagParents(ctx, id, ids)
	}
	if ids, ok := patchIDList(fields, "child_ids"); ok {
		_ = h.tagService.SetTagChildren(ctx, id, ids)
	}
	if raw, ok := fields["locations"]; ok && !isJSONNull(raw) {
		var locs []TagLocationInput
		if json.Unmarshal(raw, &locs) == nil && len(locs) > 0 {
			_ = h.tagService.UpsertTagLocation(ctx, id, locs[0].Latitude, locs[0].Longitude)
		}
	}
}

func (h *TagHandler) DeleteTag(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	if err := h.tagService.DeleteTag(c.Request().Context(), id); err != nil {
		return MapError(err)
	}

	return c.NoContent(http.StatusNoContent)
}

type ReorderTagRequest struct {
	TargetID *int64 `json:"target_id"`
	Position string `json:"position"` // "before" or "after"
	ParentID *int64 `json:"parent_id"`
}

func (h *TagHandler) ReorderTag(c echo.Context) error {
	id, err := parseNamedIDParam(c, "tag id")
	if err != nil {
		return err
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
		return MapError(err)
	}
	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

func (h *TagHandler) GeocodeTag(c echo.Context) error {
	id, err := parseNamedIDParam(c, "tag id")
	if err != nil {
		return err
	}
	lat, lon, err := h.tagService.GeocodeTag(c.Request().Context(), id)
	if err != nil {
		return MapError(err)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"latitude":  lat,
		"longitude": lon,
	})
}

func (h *TagHandler) RecalculateCounts(c echo.Context) error {
	if err := h.tagService.UpdateAllPostCounts(c.Request().Context()); err != nil {
		return MapError(err)
	}
	return c.JSON(http.StatusOK, map[string]string{"message": "Tag counts recalculated successfully"})
}

// SetTagParents replaces all parent relationships for a tag.
// Accepts {"ids": [1, 2, 3]}. An empty array removes all parents (tag becomes unfiled).
func (h *TagHandler) SetTagParents(c echo.Context) error {
	return h.setTagRelations(c, h.tagService.SetTagParents)
}

// SetTagChildren replaces all child relationships for a tag.
// Accepts {"ids": [1, 2, 3]}. An empty array removes all children.
func (h *TagHandler) SetTagChildren(c echo.Context) error {
	return h.setTagRelations(c, h.tagService.SetTagChildren)
}

// setTagRelations is the shared body of the parents and children endpoints,
// which differ only in the service call they make.
func (h *TagHandler) setTagRelations(c echo.Context, set func(ctx context.Context, id int64, ids []int64) error) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	var req struct {
		IDs []int64 `json:"ids"`
	}
	if err := c.Bind(&req); err != nil {
		return badTagRequest()
	}

	if err := set(c.Request().Context(), id, req.IDs); err != nil {
		return MapError(err)
	}

	return h.renderSavedTag(c, id, http.StatusOK)
}

// MoveTagRequest is the body for POST /api/tags/:id/move.
type MoveTagRequest struct {
	ParentID int64  `json:"parent_id"`
	AfterID  *int64 `json:"after_id"` // nil = move to front of the sibling group
}

// MoveTag repositions a tag within its sibling group under a specific parent.
// Only that sibling group's sort_order values are renumbered; all other parents
// are untouched.
func (h *TagHandler) MoveTag(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	var req MoveTagRequest
	if err := c.Bind(&req); err != nil {
		return badTagRequest()
	}

	if err := h.tagService.MoveTag(c.Request().Context(), services.MoveTagParams{
		ID:       id,
		ParentID: req.ParentID,
		AfterID:  req.AfterID,
	}); err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

func (h *TagHandler) GetPostsByTag(c echo.Context) error {
	ctx := c.Request().Context()

	v, err := h.tagView(c)
	if err != nil {
		return err
	}
	tag, ok := v.g.BySlug[strings.ToLower(c.Param("slug"))]
	if !ok || v.hidden(tag.ID) {
		return tagNotFound()
	}
	// A tag can be visible itself while still withholding its posts.
	if v.publicOnly && v.g.EffectiveHidesPosts[tag.ID] {
		return tagNotFound()
	}

	perPageStr, _ := h.settingsService.GetSetting(ctx, "posts_per_page", "10")
	defaultPerPage, _ := strconv.ParseInt(perPageStr, 10, 32)
	page, perPage := ParsePaginationParams(c, int(defaultPerPage))

	posts, total, err := h.tagService.GetPostsByTag(ctx, tag.ID, page, perPage, v.publicOnly, false, 0, 0)
	if err != nil {
		return MapError(err)
	}

	postIDs := make([]int64, len(posts))
	for i, p := range posts {
		postIDs[i] = p.ID
	}
	postTagsMap, _ := h.tagService.GetTagsByPostIDs(ctx, postIDs)

	excluded := v.excluded()
	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		resp := postToListResponse(p, postTagsMap[p.ID], excluded)
		if !v.publicOnly {
			injectPostHiddenFieldsFromInfo(resp, p.Status, postTagsMap[p.ID], v.g.EffectiveHidesPosts)
		}
		postResponses[i] = resp
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":          tag.ID,
		"name":        tag.Name,
		"slug":        tag.Slug,
		"description": nullString(tag.Description),
		"post_count":  v.count(tag.ID),
		"posts":       postResponses,
		"total_posts": total,
		"page":        page,
		"per_page":    perPage,
		"pages":       int(math.Ceil(float64(total) / float64(perPage))),
	})
}

func (h *TagHandler) MergeTags(c echo.Context) error {
	loserID, err := parseIDParam(c)
	if err != nil {
		return err
	}
	var req struct {
		WinnerID     int64 `json:"winner_id"`
		KeepRedirect bool  `json:"keep_redirect"`
	}
	if err := c.Bind(&req); err != nil {
		return badTagRequest()
	}
	if err := h.tagService.MergeTags(c.Request().Context(), req.WinnerID, loserID); err != nil {
		return MapError(err)
	}
	return c.NoContent(http.StatusNoContent)
}
