package api

import (
	"math"
	"net/http"
	"strconv"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
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

func tagResponse(tag models.Tag, parents, children []models.Tag) map[string]interface{} {
	return tagToFullResponse(tag, parents, children)
}

func (h *TagHandler) ListTags(c echo.Context) error {
	includeEmpty := c.QueryParam("include_empty") != "false"
	importantOnly := c.QueryParam("important_only") == "true"

	tags, err := h.tagService.ListTags(c.Request().Context(), includeEmpty, importantOnly)
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

	tagItems := make([]map[string]interface{}, len(tags))
	for i, t := range tags {
		parents := childParents[t.ID]
		if parents == nil {
			parents = []map[string]interface{}{}
		}
		children := parentChildren[t.ID]
		if children == nil {
			children = []map[string]interface{}{}
		}
		tagItems[i] = map[string]interface{}{
			"id":                            t.ID,
			"name":                          t.Name,
			"slug":                          t.Slug,
			"description":                   nullString(t.Description),
			"custom_url":                    nullString(t.CustomUrl),
			"is_important":                  t.IsImportant,
			"is_featured":                   t.IsFeatured,
			"is_hidden":                     t.IsHidden,
			"is_hidden_posts":               t.IsHiddenPosts,
			"include_in_breadcrumbs":        t.IncludeInBreadcrumbs,
			"show_related_tags_as_children": t.ShowRelatedTagsAsChildren,
			"sort_order":                    nullInt64(t.SortOrder),
			"post_count":                    t.PostCount,
			"parents":                       parents,
			"children":                      children,
		}
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

	cloud, err := h.tagService.GetTagCloud(c.Request().Context(), limit)
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

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID)

	return c.JSON(http.StatusOK, tagResponse(tag, parents, children))
}

func (h *TagHandler) GetTagBySlug(c echo.Context) error {
	slug := c.Param("slug")

	tag, err := h.tagService.GetTagBySlug(c.Request().Context(), slug)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID)

	return c.JSON(http.StatusOK, tagResponse(tag, parents, children))
}

type CreateTagRequest struct {
	Name                      string  `json:"name"`
	Slug                      string  `json:"slug"`
	Description               string  `json:"description"`
	CustomURL                 string  `json:"custom_url"`
	IsImportant               bool    `json:"is_important"`
	IsFeatured                bool    `json:"is_featured"`
	IsHidden                  bool    `json:"is_hidden"`
	IsHiddenPosts             bool    `json:"is_hidden_posts"`
	IncludeInBreadcrumbs      bool    `json:"include_in_breadcrumbs"`
	ShowRelatedTagsAsChildren bool    `json:"show_related_tags_as_children"`
	SortOrder                 *int32  `json:"sort_order"`
	ParentIDs                 []int64 `json:"parent_ids"`
	ChildIDs                  []int64 `json:"child_ids"`
}

func (h *TagHandler) CreateTag(c echo.Context) error {
	var req CreateTagRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	tag, err := h.tagService.CreateTag(c.Request().Context(), services.CreateTagParams{
		Name:                      req.Name,
		Slug:                      req.Slug,
		Description:               req.Description,
		CustomURL:                 req.CustomURL,
		IsImportant:               req.IsImportant,
		IsFeatured:                req.IsFeatured,
		IsHidden:                  req.IsHidden,
		IsHiddenPosts:             req.IsHiddenPosts,
		IncludeInBreadcrumbs:      req.IncludeInBreadcrumbs,
		ShowRelatedTagsAsChildren: req.ShowRelatedTagsAsChildren,
		SortOrder:                 req.SortOrder,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusConflict, err.Error())
	}

	_ = h.tagService.SetTagParents(c.Request().Context(), tag.ID, req.ParentIDs)
	_ = h.tagService.SetTagChildren(c.Request().Context(), tag.ID, req.ChildIDs)

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID)

	return c.JSON(http.StatusCreated, tagResponse(tag, parents, children))
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
		ID:                        id,
		Name:                      req.Name,
		Slug:                      req.Slug,
		Description:               req.Description,
		CustomURL:                 req.CustomURL,
		IsImportant:               req.IsImportant,
		IsFeatured:                req.IsFeatured,
		IsHidden:                  req.IsHidden,
		IsHiddenPosts:             req.IsHiddenPosts,
		IncludeInBreadcrumbs:      req.IncludeInBreadcrumbs,
		ShowRelatedTagsAsChildren: req.ShowRelatedTagsAsChildren,
		SortOrder:                 req.SortOrder,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
	}

	// Always update parent and child relationships (empty slice = remove all).
	_ = h.tagService.SetTagParents(c.Request().Context(), tag.ID, req.ParentIDs)
	_ = h.tagService.SetTagChildren(c.Request().Context(), tag.ID, req.ChildIDs)

	parents, _ := h.tagService.GetTagParents(c.Request().Context(), tag.ID)
	children, _ := h.tagService.GetTagChildren(c.Request().Context(), tag.ID)

	return c.JSON(http.StatusOK, tagResponse(tag, parents, children))
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

	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}

	perPage, _ := strconv.Atoi(c.QueryParam("per_page"))
	if perPage < 1 {
		perPageStr, _ := h.settingsService.GetSetting(c.Request().Context(), "posts_per_page", "10")
		perPage, _ = strconv.Atoi(perPageStr)
	}

	publishedOnly := c.Get("user") == nil

	posts, total, err := h.tagService.GetPostsByTag(c.Request().Context(), tag.ID, int32(page), int32(perPage), publishedOnly)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	postResponses := make([]map[string]interface{}, len(posts))
	for i, p := range posts {
		postResponses[i] = postByTagToResponse(p)
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
