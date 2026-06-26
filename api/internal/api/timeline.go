package api

import (
	"net/http"
	"strconv"

	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type TimelineHandler struct {
	timelineService *services.TimelineService
	settingsService *services.SettingsService
}

func NewTimelineHandler(timelineService *services.TimelineService, settingsService *services.SettingsService) *TimelineHandler {
	return &TimelineHandler{
		timelineService: timelineService,
		settingsService: settingsService,
	}
}

// timelineGate enforces plugin enabled state.
func (h *TimelineHandler) timelineGate(c echo.Context) error {
	settings, _ := h.settingsService.GetAllSettings(c.Request().Context())
	if !plugins.IsEnabled("timeline", settings) {
		return echo.NewHTTPError(http.StatusNotFound, "timeline not found")
	}
	return nil
}

// GetTimeline handles GET /api/timeline?context=<slug?>
func (h *TimelineHandler) GetTimeline(c echo.Context) error {
	if err := h.timelineGate(c); err != nil {
		return err
	}
	context := c.QueryParam("context")
	payload, err := h.timelineService.Timeline(c.Request().Context(), context)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if len(payload.Pills) == 0 {
		return echo.NewHTTPError(http.StatusNotFound, "timeline not found")
	}
	return c.JSON(http.StatusOK, payload)
}

// GetTimelineLocations handles GET /api/timeline/locations?tag=<slug>&context=<slug?>&limit=10
func (h *TimelineHandler) GetTimelineLocations(c echo.Context) error {
	if err := h.timelineGate(c); err != nil {
		return err
	}
	tag := c.QueryParam("tag")
	if tag == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "tag parameter required")
	}
	context := c.QueryParam("context")
	limit := 10
	if l, err := strconv.Atoi(c.QueryParam("limit")); err == nil && l > 0 {
		limit = l
	}
	locs, err := h.timelineService.LocationsFor(c.Request().Context(), tag, context, limit)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if locs == nil {
		locs = []services.LocationLink{}
	}
	return c.JSON(http.StatusOK, locs)
}
