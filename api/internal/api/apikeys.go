package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

type ApiKeyHandler struct {
	apiKeyService *services.ApiKeyService
}

func NewApiKeyHandler(apiKeyService *services.ApiKeyService) *ApiKeyHandler {
	return &ApiKeyHandler{
		apiKeyService: apiKeyService,
	}
}

func (h *ApiKeyHandler) ListKeys(c echo.Context) error {
	userID := extractUserID(c.Get("user"))
	keys, err := h.apiKeyService.ListKeys(c.Request().Context(), userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	resp := make([]map[string]interface{}, len(keys))
	for i, k := range keys {
		resp[i] = apiKeyToResponse(k)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"api_keys": resp,
		"total":    len(resp),
	})
}

type CreateApiKeyRequest struct {
	Name      string     `json:"name"`
	ExpiresAt *time.Time `json:"expires_at"`
}

func (h *ApiKeyHandler) CreateKey(c echo.Context) error {
	userID := extractUserID(c.Get("user"))
	var req CreateApiKeyRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if req.Name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name is required")
	}

	rawKey, apiKey, err := h.apiKeyService.GenerateAPIKey(c.Request().Context(), userID, req.Name, req.ExpiresAt)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusCreated, map[string]interface{}{
		"api_key": apiKeyToResponse(apiKey),
		"raw_key": rawKey, // Raw key returned only once
	})
}

func (h *ApiKeyHandler) RevokeKey(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	userID := extractUserID(c.Get("user"))
	if err := h.apiKeyService.RevokeKey(c.Request().Context(), id, userID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.NoContent(http.StatusNoContent)
}

func (h *ApiKeyHandler) DeleteKey(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	userID := extractUserID(c.Get("user"))
	if err := h.apiKeyService.DeleteKey(c.Request().Context(), id, userID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.NoContent(http.StatusNoContent)
}
