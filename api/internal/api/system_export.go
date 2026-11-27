package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/labstack/echo/v4"

	"point-api/internal/services"
	"point-api/internal/utils"
)

// exportTokenPrefix keeps download tokens for an export apart from tokens for
// a backup of the same name.
const exportTokenPrefix = "export/"

// GetExport returns the result of the last portable export (null when none
// has run) and whether an export is running now.
func (h *SystemHandler) GetExport(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]any{
		"running": h.systemService.ExportRunning(),
		"last":    h.systemService.LastExport(),
	})
}

// StartExport starts a portable export in the background. The archive holds a
// copy of every original, so it can take minutes; GetExport shows the result.
func (h *SystemHandler) StartExport(c echo.Context) error {
	if h.systemService.ExportRunning() {
		return MapError(services.ErrExportInProgress)
	}
	// The export is about the size of the originals, which the data
	// directory holds; the backup space check is a safe upper bound.
	if err := h.systemService.CheckBackupSpace(); err != nil {
		return MapError(err)
	}
	version := h.appVersion
	utils.SafeGo("system: portable export", func() {
		if _, err := h.systemService.CreateExport(context.Background(), version); err != nil {
			slog.Error("export failed", "err", err)
		}
	})
	return c.JSON(http.StatusAccepted, map[string]string{"status": "started"})
}

// AuthorizeExportDownload re-verifies the account password and issues a
// short-lived single-use token for DownloadExport, as for a backup: the
// export holds every original, private files included.
func (h *SystemHandler) AuthorizeExportDownload(c echo.Context) error {
	ctx := c.Request().Context()
	userID := extractUserID(c.Get("user"))
	filename := c.Param("filename")
	if _, err := h.systemService.ExportPath(filename); err != nil {
		return MapError(err)
	}
	var req AuthorizeDownloadRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}
	if err := h.authService.VerifyUserPassword(ctx, userID, req.CurrentPassword); err != nil {
		return MapError(err)
	}
	token, err := h.downloadTokens.Issue(userID, exportTokenPrefix+filename)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not authorize download")
	}
	return c.JSON(http.StatusOK, map[string]string{"token": token})
}

// DownloadExport streams the export archive after it validates the one-time
// token from AuthorizeExportDownload. c.Attachment supports Range requests.
func (h *SystemHandler) DownloadExport(c echo.Context) error {
	userID := extractUserID(c.Get("user"))
	filename := c.Param("filename")
	tokUserID, tokFile, ok := h.downloadTokens.Consume(c.QueryParam("token"))
	if !ok || tokUserID != userID || tokFile != exportTokenPrefix+filename {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid or expired download token")
	}
	p, err := h.systemService.ExportPath(filename)
	if err != nil {
		return MapError(err)
	}
	if last := h.systemService.LastExport(); last != nil && last.Filename == filename && last.Sha256 != "" {
		c.Response().Header().Set("X-Archive-SHA256", last.Sha256)
	}
	return c.Attachment(p, filename)
}

// GetImport returns the state of the portable import: whether one is running
// and its progress, the result of the last import (null when none has run),
// and whether the site is empty, as the import requires.
func (h *SystemHandler) GetImport(c echo.Context) error {
	empty, err := h.importService.InstanceEmpty(c.Request().Context())
	if err != nil {
		return MapError(err)
	}
	return c.JSON(http.StatusOK, map[string]any{
		"running":  h.importService.Running(),
		"progress": h.importService.Progress(),
		"last":     h.importService.LastImport(),
		"empty":    empty,
	})
}

// StartImport streams a portable export archive (the raw request body) to
// disk and starts the import in the background. The X-Confirm-Password header
// holds the account password, SHA-256-hashed as at login. The import refuses a
// site that has posts or media, and an archive with an unknown format version.
// The route is excluded from the global body-size limit.
func (h *SystemHandler) StartImport(c echo.Context) error {
	ctx := c.Request().Context()
	userID := extractUserID(c.Get("user"))
	if err := h.authService.VerifyUserPassword(ctx, userID, c.Request().Header.Get("X-Confirm-Password")); err != nil {
		return MapError(err)
	}
	if err := h.importService.StartImport(ctx, c.Request().Body, userID); err != nil {
		return MapError(err)
	}
	return c.JSON(http.StatusAccepted, map[string]string{"status": "started"})
}
