package api

import (
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

type MediaHandler struct {
	mediaService    *services.MediaService
	settingsService *services.SettingsService
}

func NewMediaHandler(mediaService *services.MediaService, settingsService *services.SettingsService) *MediaHandler {
	return &MediaHandler{
		mediaService:    mediaService,
		settingsService: settingsService,
	}
}

func (h *MediaHandler) UploadFile(c echo.Context) error {
	file, err := c.FormFile("file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "file is required")
	}

	src, err := file.Open()
	if err != nil {
		return err
	}
	defer func() {
		_ = src.Close()
	}()

	content, err := io.ReadAll(src)
	if err != nil {
		return err
	}

	altText := c.FormValue("alt_text")
	caption := c.FormValue("caption")
	postIDStr := c.FormValue("post_id")
	var postID *int64
	if postIDStr != "" {
		id, err := strconv.ParseInt(postIDStr, 10, 64)
		if err == nil {
			postID = &id
		}
	}

	media, err := h.mediaService.UploadFile(c.Request().Context(), services.UploadFileParams{
		Content:  content,
		Filename: file.Filename,
		MimeType: file.Header.Get("Content-Type"),
		AltText:  altText,
		Caption:  caption,
		PostID:   postID,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusCreated, mediaToResponse(media))
}

func (h *MediaHandler) ListMedia(c echo.Context) error {
	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}
	perPage, _ := strconv.Atoi(c.QueryParam("per_page"))
	if perPage < 1 {
		perPage = 20
	}
	fileType := c.QueryParam("file_type")
	folder := c.QueryParam("folder")

	media, total, err := h.mediaService.ListMedia(c.Request().Context(), services.ListMediaParams{
		Page:     int32(page),
		PerPage:  int32(perPage),
		FileType: fileType,
		Folder:   folder,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	items := make([]map[string]interface{}, len(media))
	for i, m := range media {
		items[i] = mediaToResponse(m)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"media":    items,
		"total":    total,
		"page":     page,
		"per_page": perPage,
		"pages":    pages,
	})
}

func (h *MediaHandler) GetMediaFolders(c echo.Context) error {
	fileType := c.QueryParam("file_type")
	folders, err := h.mediaService.GetMediaFolders(c.Request().Context(), fileType)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	items := make([]map[string]interface{}, 0, len(folders))
	for _, f := range folders {
		items = append(items, map[string]interface{}{
			"year":  f.Year,
			"month": f.Month,
			"path":  f.Year + "/" + f.Month,
		})
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"folders": items})
}

func (h *MediaHandler) GetMedia(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	media, err := h.mediaService.GetMediaByID(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}

	return c.JSON(http.StatusOK, mediaToResponse(media))
}

type UpdateMediaRequest struct {
	AltText  string                  `json:"alt_text"`
	Caption  string                  `json:"caption"`
	PostID   *int64                  `json:"post_id"`
	Metadata *map[string]interface{} `json:"metadata"`
}

func (h *MediaHandler) UpdateMedia(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	var req UpdateMediaRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	media, err := h.mediaService.UpdateMedia(c.Request().Context(), services.UpdateMediaParams{
		ID:       id,
		AltText:  req.AltText,
		Caption:  req.Caption,
		PostID:   req.PostID,
		Metadata: req.Metadata,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}

	return c.JSON(http.StatusOK, mediaToResponse(media))
}

func (h *MediaHandler) ReextractEXIF(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}
	media, err := h.mediaService.ReextractEXIF(c.Request().Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, mediaToResponse(media))
}

// UpdateEXIFRequest is the body for PUT /api/media/:id/exif.
// Keys are EXIF field names; values must contain only [a-zA-Z0-9 ].
type UpdateEXIFRequest map[string]string

func (h *MediaHandler) UpdateEXIF(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	var req UpdateEXIFRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	media, err := h.mediaService.UpdateEXIF(c.Request().Context(), services.UpdateEXIFParams{
		ID:     id,
		Fields: req,
	})
	if err != nil {
		if strings.Contains(err.Error(), "disallowed characters") {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		if strings.Contains(err.Error(), "no rows") {
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, mediaToResponse(media))
}

func (h *MediaHandler) RevertEXIF(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	media, err := h.mediaService.RevertEXIF(c.Request().Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "no rows") {
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}
		if strings.Contains(err.Error(), "no original metadata") {
			return echo.NewHTTPError(http.StatusConflict, err.Error())
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, mediaToResponse(media))
}

func (h *MediaHandler) ListOrphanedMedia(c echo.Context) error {
	page, _ := strconv.Atoi(c.QueryParam("page"))
	if page < 1 {
		page = 1
	}
	perPage, _ := strconv.Atoi(c.QueryParam("per_page"))
	if perPage < 1 {
		perPage = 20
	}

	media, total, err := h.mediaService.ListOrphanedMedia(c.Request().Context(), int32(page), int32(perPage))
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	orphaned := make([]map[string]interface{}, len(media))
	for i, m := range media {
		orphaned[i] = mediaToResponse(m)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"media":    orphaned,
		"total":    total,
		"page":     page,
		"per_page": perPage,
		"pages":    pages,
	})
}

type BulkDeleteRequest struct {
	IDs []int64 `json:"ids"`
}

func (h *MediaHandler) BulkDeleteMedia(c echo.Context) error {
	var req BulkDeleteRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if len(req.IDs) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "no ids provided")
	}

	count, err := h.mediaService.BulkDeleteMedia(c.Request().Context(), req.IDs)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"deleted": count,
		"message": fmt.Sprintf("Deleted %d media files", count),
	})
}

func (h *MediaHandler) DeleteMedia(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	err = h.mediaService.DeleteMedia(c.Request().Context(), id)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.NoContent(http.StatusNoContent)
}

func (h *MediaHandler) UploadMultiple(c echo.Context) error {
	form, err := c.MultipartForm()
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid multipart form")
	}
	files := form.File["files"]
	if len(files) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "no files provided")
	}

	postIDStr := c.FormValue("post_id")
	var postID *int64
	if postIDStr != "" {
		if id, err := strconv.ParseInt(postIDStr, 10, 64); err == nil {
			postID = &id
		}
	}

	var uploaded []interface{}
	var failed []interface{}

	for _, fh := range files {
		src, err := fh.Open()
		if err != nil {
			failed = append(failed, map[string]string{"filename": fh.Filename, "error": err.Error()})
			continue
		}
		content, err := io.ReadAll(src)
		_ = src.Close()
		if err != nil {
			failed = append(failed, map[string]string{"filename": fh.Filename, "error": err.Error()})
			continue
		}

		media, err := h.mediaService.UploadFile(c.Request().Context(), services.UploadFileParams{
			Content:  content,
			Filename: fh.Filename,
			MimeType: fh.Header.Get("Content-Type"),
			PostID:   postID,
		})
		if err != nil {
			failed = append(failed, map[string]string{"filename": fh.Filename, "error": err.Error()})
			continue
		}
		uploaded = append(uploaded, mediaToResponse(media))
	}

	return c.JSON(http.StatusCreated, map[string]interface{}{
		"uploaded":       uploaded,
		"failed":         failed,
		"total_uploaded": len(uploaded),
		"total_failed":   len(failed),
	})
}

func (h *MediaHandler) GetStorageStats(c echo.Context) error {
	stats, err := h.mediaService.GetStorageStats(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, stats)
}

type RenameMediaRequest struct {
	NewFilename string `json:"new_filename"`
}

func (h *MediaHandler) RenameMedia(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	var req RenameMediaRequest
	if err := c.Bind(&req); err != nil || req.NewFilename == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "new_filename is required")
	}

	// Validate: only letters, digits, hyphens and underscores allowed in the base name.
	validName := regexp.MustCompile(`^[a-zA-Z0-9_\-\.]+$`)
	if !validName.MatchString(req.NewFilename) {
		return echo.NewHTTPError(http.StatusBadRequest, "filename may only contain letters, digits, hyphens and underscores")
	}

	media, err := h.mediaService.RenameMedia(c.Request().Context(), id, req.NewFilename)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, mediaToResponse(media))
}

func (h *MediaHandler) DeleteOrphanedMedia(c echo.Context) error {
	count, freed, err := h.mediaService.CleanupOrphaned(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"message":       fmt.Sprintf("Deleted %d orphaned files", count),
		"deleted_count": count,
		"freed_bytes":   freed,
		"failed_count":  0,
	})
}

func (h *MediaHandler) RebuildThumbnails(c echo.Context) error {
	onlyMissing := c.QueryParam("only_missing") != "false"

	stats, err := h.mediaService.RebuildThumbnails(c.Request().Context(), onlyMissing)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"message": fmt.Sprintf("Thumbnail rebuild complete. Processed %d images.", stats["processed"]),
		"stats":   stats,
	})
}

func (h *MediaHandler) AnalyzeImage(c echo.Context) error {
	file, err := c.FormFile("image")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "image file is required")
	}

	src, err := file.Open()
	if err != nil {
		return err
	}
	defer func() {
		_ = src.Close()
	}()

	content, err := io.ReadAll(src)
	if err != nil {
		return err
	}

	analysis, err := h.mediaService.AnalyzeImage(c.Request().Context(), content, file.Filename, file.Header.Get("Content-Type"))
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, analysis)
}

func (h *MediaHandler) AnalyzeImageByPath(c echo.Context) error {
	var req struct {
		Path string `json:"path"`
	}
	if err := c.Bind(&req); err != nil || req.Path == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "path is required")
	}

	analysis, err := h.mediaService.AnalyzeMediaByPath(c.Request().Context(), req.Path)
	if err != nil {
		if errors.Is(err, services.ErrNotAnImage) {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, analysis)
}

func (h *MediaHandler) AnalyzeImageByID(c echo.Context) error {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}

	analysis, err := h.mediaService.AnalyzeMediaByID(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, services.ErrMediaNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, err.Error())
		}
		if errors.Is(err, services.ErrNotAnImage) {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, analysis)
}
