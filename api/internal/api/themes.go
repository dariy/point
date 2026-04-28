package api

import (
	"net/http"
	
	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

type ThemeHandler struct {
	themeService *services.ThemeService
}

func NewThemeHandler(themeService *services.ThemeService) *ThemeHandler {
	return &ThemeHandler{themeService: themeService}
}

func (h *ThemeHandler) ListThemes(c echo.Context) error {
	themes, err := h.themeService.ListThemes()
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": err.Error()})
	}
	return c.JSON(http.StatusOK, themes)
}

func (h *ThemeHandler) GetActiveTheme(c echo.Context) error {
	theme, err := h.themeService.GetActiveTheme(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": err.Error()})
	}
	return c.JSON(http.StatusOK, theme)
}

type updateActiveThemeRequest struct {
	Name string `json:"name"`
}

func (h *ThemeHandler) SetActiveTheme(c echo.Context) error {
	var req updateActiveThemeRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "invalid request format"})
	}

	if req.Name == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "theme name is required"})
	}

	err := h.themeService.SetActiveTheme(c.Request().Context(), req.Name)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "success"})
}
