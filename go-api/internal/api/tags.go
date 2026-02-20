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
	toItem := func(t models.Tag) map[string]interface{} {
		return map[string]interface{}{
			"id":                     t.ID,
			"name":                   t.Name,
			"slug":                   t.Slug,
			"is_important":           t.IsImportant,
			"is_hidden":              t.IsHidden,
			"is_hidden_posts":        t.IsHiddenPosts,
			"include_in_breadcrumbs": t.IncludeInBreadcrumbs,
			"sort_order":             t.SortOrder,
			"post_count":             t.PostCount,
		}
	}

	parentItems := make([]map[string]interface{}, len(parents))
	for i, p := range parents {
		parentItems[i] = toItem(p)
	}
	childItems := make([]map[string]interface{}, len(children))
	for i, ch := range children {
		childItems[i] = toItem(ch)
	}

	return map[string]interface{}{
		"id":                           tag.ID,
		"name":                         tag.Name,
		"slug":                         tag.Slug,
		"description":                  tag.Description,
		"custom_url":                   tag.CustomUrl,
		"is_important":                 tag.IsImportant,
		"is_featured":                  tag.IsFeatured,
		"is_hidden":                    tag.IsHidden,
		"is_hidden_posts":              tag.IsHiddenPosts,
		"include_in_breadcrumbs":       tag.IncludeInBreadcrumbs,
		"show_related_tags_as_children": tag.ShowRelatedTagsAsChildren,
		"sort_order":                   tag.SortOrder,
		"post_count":                   tag.PostCount,
		"created_at":                   tag.CreatedAt,
		"parents":                      parentItems,
		"children":                     childItems,
	}
}

func (h *TagHandler) ListTags(c echo.Context) error {
	includeEmpty := c.QueryParam("include_empty") != "false"
	importantOnly := c.QueryParam("important_only") == "true"

	tags, err := h.tagService.ListTags(c.Request().Context(), includeEmpty, importantOnly)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"tags":  tags,
		"total": len(tags),
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
	Name                      string `json:"name"`
	Slug                      string `json:"slug"`
	Description               string `json:"description"`
	CustomURL                 string `json:"custom_url"`
	IsImportant               bool   `json:"is_important"`
	IsFeatured                bool   `json:"is_featured"`
	IsHidden                  bool   `json:"is_hidden"`
	IsHiddenPosts             bool   `json:"is_hidden_posts"`
	IncludeInBreadcrumbs      bool   `json:"include_in_breadcrumbs"`
	ShowRelatedTagsAsChildren bool   `json:"show_related_tags_as_children"`
	SortOrder                 *int32 `json:"sort_order"`
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

	return c.JSON(http.StatusCreated, tagResponse(tag, nil, nil))
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

	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":          tag.ID,
		"name":        tag.Name,
		"slug":        tag.Slug,
		"description": tag.Description,
		"post_count":  tag.PostCount,
		"posts":       posts,
		"total_posts": total,
		"page":        page,
		"per_page":    perPage,
		"pages":       int(math.Ceil(float64(total) / float64(perPage))),
	})
}
