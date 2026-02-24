package api

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"

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
	defer src.Close()

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

	return c.JSON(http.StatusCreated, media)
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

	media, total, err := h.mediaService.ListMedia(c.Request().Context(), services.ListMediaParams{
		Page:     int32(page),
		PerPage:  int32(perPage),
		FileType: fileType,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"media":    media,
		"total":    total,
		"page":     page,
		"per_page": perPage,
		"pages":    pages,
	})
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

	return c.JSON(http.StatusOK, media)
}

type UpdateMediaRequest struct {
	AltText string `json:"alt_text"`
	Caption string `json:"caption"`
	PostID  *int64 `json:"post_id"`
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
		ID:      id,
		AltText: req.AltText,
		Caption: req.Caption,
		PostID:  req.PostID,
	})
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}

	return c.JSON(http.StatusOK, media)
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

	return c.JSON(http.StatusOK, map[string]interface{}{
		"media":    media,
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
		src.Close()
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
		uploaded = append(uploaded, media)
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

	media, err := h.mediaService.RenameMedia(c.Request().Context(), id, req.NewFilename)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, media)
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
	defer src.Close()

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
