package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type NavMenuHandler struct {
	settingsService *services.SettingsService
	tagService      *services.TagService
}

func NewNavMenuHandler(settingsService *services.SettingsService, tagService *services.TagService) *NavMenuHandler {
	return &NavMenuHandler{settingsService: settingsService, tagService: tagService}
}

// GetAdminNavMenu returns the current nav menu configuration for the admin editor.
// GET /api/nav-menu
func (h *NavMenuHandler) GetAdminNavMenu(c echo.Context) error {
	ctx := c.Request().Context()
	all, _ := h.settingsService.GetAllSettings(ctx)

	mode := all["nav_menu_mode"]
	if mode == "" {
		mode = "tags"
	}

	var items []services.NavTagNode
	if raw := all["custom_nav_menu"]; raw != "" {
		_ = json.Unmarshal([]byte(raw), &items)
	}
	if items == nil {
		items = []services.NavTagNode{}
	}

	// The tags-mode tree regardless of the active mode, so the menu editor can
	// preview a mode switch without saving first.
	tagItems := []services.NavTagNode{}
	if h.tagService != nil {
		if nodes, err := h.tagService.GetHierarchicalNavTags(ctx, nil, false, 0); err == nil && nodes != nil {
			tagItems = nodes
		}
	}

	moreTitle := all["nav_more_title"]
	if moreTitle == "" {
		moreTitle = "More"
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"mode":            mode,
		"items":           items,
		"custom_markdown": all["custom_markdown"],
		"inline_max":      inlineMaxOrDefault(all["nav_inline_max"]),
		"more_title":      moreTitle,
		"tag_items":       tagItems,
	})
}

// inlineMaxOrDefault parses the nav_inline_max setting; out-of-range or unset
// values fall back to the default of 4 visible links.
func inlineMaxOrDefault(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 10 {
		return 4
	}
	return n
}

// UpdateAdminNavMenu saves the nav menu mode and custom items.
// PUT /api/nav-menu
func (h *NavMenuHandler) UpdateAdminNavMenu(c echo.Context) error {
	ctx := c.Request().Context()

	var body struct {
		Mode           string                `json:"mode"`
		Items          []services.NavTagNode `json:"items"`
		CustomMarkdown string                `json:"custom_markdown"`
		InlineMax      int                   `json:"inline_max"`
		MoreTitle      string                `json:"more_title"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if body.Mode != "tags" && body.Mode != "custom" && body.Mode != "none" {
		body.Mode = "tags"
	}

	if err := h.settingsService.SetSetting(ctx, "nav_menu_mode", body.Mode, "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	if body.InlineMax >= 1 && body.InlineMax <= 10 {
		if err := h.settingsService.SetSetting(ctx, "nav_inline_max", strconv.Itoa(body.InlineMax), "string"); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}

	if body.Items == nil {
		body.Items = []services.NavTagNode{}
	}
	data, err := json.Marshal(body.Items)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to encode menu")
	}
	if err := h.settingsService.SetSetting(ctx, "custom_nav_menu", string(data), "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	if err := h.settingsService.SetSetting(ctx, "custom_markdown", body.CustomMarkdown, "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	if body.MoreTitle == "" {
		body.MoreTitle = "More"
	}
	if err := h.settingsService.SetSetting(ctx, "nav_more_title", body.MoreTitle, "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	inlineMax := body.InlineMax
	if inlineMax < 1 || inlineMax > 10 {
		all, _ := h.settingsService.GetAllSettings(ctx)
		inlineMax = inlineMaxOrDefault(all["nav_inline_max"])
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"mode":            body.Mode,
		"items":           body.Items,
		"custom_markdown": body.CustomMarkdown,
		"inline_max":      inlineMax,
		"more_title":      body.MoreTitle,
	})
}
