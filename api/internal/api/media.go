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

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// maxPosterBytes bounds a video poster frame. Posters are downscaled to the
// thumbnail box on arrival, so anything larger than this is not a frame capture.
const maxPosterBytes = 8 << 20 // 8 MB

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

// mediaResponse is mediaToResponse with the request's thumbnail generation
// token already read off the settings cache.
func (h *MediaHandler) mediaResponse(c echo.Context, m models.Medium) map[string]interface{} {
	return mediaToResponse(m, h.mediaService.ThumbnailGeneration(c.Request().Context()))
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

	// Resolve the MIME type from the file's own magic bytes, ignoring the
	// client-supplied Content-Type. Rejects anything that isn't an allowlisted
	// image/video/audio format (e.g. an HTML page renamed to .jpg).
	mimeType, err := services.DetectMediaType(content, file.Header.Get("Content-Type"))
	if err != nil {
		return echo.NewHTTPError(http.StatusUnsupportedMediaType, uploadRejectionMessage(err))
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
		MimeType: mimeType,
		AltText:  altText,
		Caption:  caption,
		PostID:   postID,
	})
	if err != nil {
		return MapError(err)
	}

	// A video upload may carry a poster frame the browser grabbed off the file
	// before sending it — the only way this build gets a video still, since the
	// server has no video decoder. Best-effort: a rejected or missing poster
	// leaves the video thumbnail-less rather than failing the upload.
	if poster, err := posterFromForm(c); err == nil && len(poster) > 0 {
		if updated, err := h.mediaService.SaveVideoPoster(c.Request().Context(), media.ID, poster); err == nil {
			media = updated
		}
	}

	return c.JSON(http.StatusCreated, h.mediaResponse(c, media))
}

// posterFromForm reads the optional "poster" upload field and returns its bytes
// once they have been confirmed to be an allowlisted image. It returns a nil
// slice and no error when the field is absent.
func posterFromForm(c echo.Context) ([]byte, error) {
	fh, err := c.FormFile("poster")
	if err != nil {
		return nil, nil
	}
	f, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = f.Close()
	}()

	// Cap the read: a poster is a single downscaled frame, and the bytes are
	// attacker-controlled up to whatever the upload limit allows.
	content, err := io.ReadAll(io.LimitReader(f, maxPosterBytes))
	if err != nil {
		return nil, err
	}

	mimeType, err := services.DetectMediaType(content, fh.Header.Get("Content-Type"))
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(mimeType, "image/") {
		return nil, services.ErrUnsupportedMediaType
	}
	return content, nil
}

// SetVideoPoster stores a client-captured frame as an existing video's
// thumbnail. It backfills videos that arrived without one — anything uploaded
// before posters existed, or ingested over the API/MCP rather than the admin UI.
func (h *MediaHandler) SetVideoPoster(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	poster, err := posterFromForm(c)
	if err != nil {
		return echo.NewHTTPError(http.StatusUnsupportedMediaType, uploadRejectionMessage(err))
	}
	if len(poster) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "poster is required")
	}

	media, err := h.mediaService.SaveVideoPoster(c.Request().Context(), id, poster)
	if err != nil {
		return MapError(err)
	}
	return c.JSON(http.StatusOK, h.mediaResponse(c, media))
}

func (h *MediaHandler) ListMedia(c echo.Context) error {
	page, perPage := ParsePaginationParams(c, 20)
	fileType := c.QueryParam("file_type")
	folder := c.QueryParam("folder")

	media, total, err := h.mediaService.ListMedia(c.Request().Context(), services.ListMediaParams{
		Page:     page,
		PerPage:  perPage,
		FileType: fileType,
		Folder:   folder,
	})
	if err != nil {
		return MapError(err)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	gen := h.mediaService.ThumbnailGeneration(c.Request().Context())
	items := make([]map[string]interface{}, len(media))
	for i, m := range media {
		items[i] = mediaToResponse(m, gen)
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
		return MapError(err)
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
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	media, err := h.mediaService.GetMediaByID(c.Request().Context(), id)
	if err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, h.mediaResponse(c, media))
}

type UpdateMediaRequest struct {
	AltText  string                  `json:"alt_text"`
	Caption  string                  `json:"caption"`
	PostID   *int64                  `json:"post_id"`
	Metadata *map[string]interface{} `json:"metadata"`
}

func (h *MediaHandler) UpdateMedia(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
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
		return MapError(err)
	}

	return c.JSON(http.StatusOK, h.mediaResponse(c, media))
}

func (h *MediaHandler) ReextractEXIF(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}
	media, err := h.mediaService.ReextractEXIF(c.Request().Context(), id)
	if err != nil {
		return MapError(err)
	}
	return c.JSON(http.StatusOK, h.mediaResponse(c, media))
}

// UpdateEXIFRequest is the body for PUT /api/media/:id/exif.
// Keys are EXIF field names; values must contain only [a-zA-Z0-9 ].
type UpdateEXIFRequest map[string]string

func (h *MediaHandler) UpdateEXIF(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
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
		return MapError(err)
	}
	return c.JSON(http.StatusOK, h.mediaResponse(c, media))
}

func (h *MediaHandler) RevertEXIF(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	media, err := h.mediaService.RevertEXIF(c.Request().Context(), id)
	if err != nil {
		return MapError(err)
	}
	return c.JSON(http.StatusOK, h.mediaResponse(c, media))
}

func (h *MediaHandler) ListOrphanedMedia(c echo.Context) error {
	page, perPage := ParsePaginationParams(c, 20)

	media, total, err := h.mediaService.ListOrphanedMedia(c.Request().Context(), page, perPage)
	if err != nil {
		return MapError(err)
	}

	pages := int(math.Ceil(float64(total) / float64(perPage)))
	if pages == 0 {
		pages = 1
	}

	gen := h.mediaService.ThumbnailGeneration(c.Request().Context())
	orphaned := make([]map[string]interface{}, len(media))
	for i, m := range media {
		orphaned[i] = mediaToResponse(m, gen)
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
		return MapError(err)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"deleted": count,
		"message": fmt.Sprintf("Deleted %d media files", count),
	})
}

func (h *MediaHandler) DeleteMedia(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	err = h.mediaService.DeleteMedia(c.Request().Context(), id)
	if err != nil {
		return MapError(err)
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

	gen := h.mediaService.ThumbnailGeneration(c.Request().Context())
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

		mimeType, err := services.DetectMediaType(content, fh.Header.Get("Content-Type"))
		if err != nil {
			failed = append(failed, map[string]string{"filename": fh.Filename, "error": uploadRejectionMessage(err)})
			continue
		}

		media, err := h.mediaService.UploadFile(c.Request().Context(), services.UploadFileParams{
			Content:  content,
			Filename: fh.Filename,
			MimeType: mimeType,
			PostID:   postID,
		})
		if err != nil {
			failed = append(failed, map[string]string{"filename": fh.Filename, "error": err.Error()})
			continue
		}
		uploaded = append(uploaded, mediaToResponse(media, gen))
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
		return MapError(err)
	}
	return c.JSON(http.StatusOK, stats)
}

type RenameMediaRequest struct {
	NewFilename string `json:"new_filename"`
}

func (h *MediaHandler) RenameMedia(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	var req RenameMediaRequest
	if err := c.Bind(&req); err != nil || req.NewFilename == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "new_filename is required")
	}

	// Validate: only letters, digits, hyphens, underscores and spaces allowed in the base name.
	validName := regexp.MustCompile(`^[a-zA-Z0-9_\-\.\s]+$`)
	if !validName.MatchString(req.NewFilename) {
		return echo.NewHTTPError(http.StatusBadRequest, "filename may only contain letters, digits, hyphens, underscores and spaces")
	}

	media, err := h.mediaService.RenameMedia(c.Request().Context(), id, req.NewFilename)
	if err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, h.mediaResponse(c, media))
}

func (h *MediaHandler) DeleteOrphanedMedia(c echo.Context) error {
	count, freed, err := h.mediaService.CleanupOrphaned(c.Request().Context())
	if err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"message":       fmt.Sprintf("Deleted %d orphaned files", count),
		"deleted_count": count,
		"freed_bytes":   freed,
		"failed_count":  0,
	})
}

// RebuildThumbnails rolls the thumbnail generation token and purges the derived
// images. It takes no parameters: a rebuild is all-or-nothing now, and the old
// only_missing flag has nothing left to mean once every file is discarded.
func (h *MediaHandler) RebuildThumbnails(c echo.Context) error {
	res, err := h.mediaService.RebuildThumbnails(c.Request().Context())
	if err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"message": fmt.Sprintf(
			"Thumbnails invalidated. Removed %d cached images; regenerating the %d most recent in the background.",
			res.Purged+res.Legacy, res.Prewarming),
		"stats": res,
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
		return MapError(err)
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
		return MapError(err)
	}

	return c.JSON(http.StatusOK, analysis)
}

func (h *MediaHandler) AnalyzeImageByID(c echo.Context) error {
	id, err := parseIDParam(c)
	if err != nil {
		return err
	}

	analysis, err := h.mediaService.AnalyzeMediaByID(c.Request().Context(), id)
	if err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, analysis)
}

// uploadRejectionMessage turns a DetectMediaType failure into something an
// admin can act on. An SVG rejected for carrying a script is a different
// problem from a .exe renamed to .jpg, and "unsupported file type" describes
// only the second.
func uploadRejectionMessage(err error) string {
	if errors.Is(err, services.ErrActiveSVGContent) {
		return err.Error()
	}
	return "unsupported file type"
}
