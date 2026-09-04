package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
)

// CarouselHandler serves the Carousel Studio document: one JSON document per
// post, stored opaque in the carousels table. The document schema is owned by
// the frontend (frontend/src/plugins/carousel/document.js) — this endpoint
// validates only that doc is a JSON object and otherwise round-trips it byte
// for byte.
//
// All three routes are gated in routes.go by RequirePlugin("carousel") ahead of
// AuthMiddleware, so a disabled plugin 404s before any of this runs.
type CarouselHandler struct {
	repo repository.Repository
}

func NewCarouselHandler(repo repository.Repository) *CarouselHandler {
	return &CarouselHandler{repo: repo}
}

// carouselResponse is the wire shape for GET and PUT: the stored document,
// parsed back into JSON so the client gets an object rather than a quoted
// string, plus the row's timestamps.
type carouselResponse struct {
	PostID    int64           `json:"post_id"`
	Doc       json.RawMessage `json:"doc"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
}

type carouselRequest struct {
	Doc json.RawMessage `json:"doc"`
}

func newCarouselResponse(row models.Carousel) carouselResponse {
	return carouselResponse{
		PostID:    row.PostID,
		Doc:       json.RawMessage(row.Doc),
		CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// postParam reads and validates the ?post=<id> query parameter shared by every
// carousel route.
func postParam(c echo.Context) (int64, error) {
	raw := c.QueryParam("post")
	if raw == "" {
		return 0, echo.NewHTTPError(http.StatusBadRequest, "post query parameter is required")
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, echo.NewHTTPError(http.StatusBadRequest, "post must be a positive integer")
	}
	return id, nil
}

// GetCarousel returns the carousel document for a post, or 404 if the post has
// no carousel yet.
func (h *CarouselHandler) GetCarousel(c echo.Context) error {
	postID, err := postParam(c)
	if err != nil {
		return err
	}

	row, err := h.repo.GetCarouselByPostID(c.Request().Context(), postID)
	if errors.Is(err, sql.ErrNoRows) {
		return echo.NewHTTPError(http.StatusNotFound, "no carousel for this post")
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newCarouselResponse(row))
}

// SaveCarousel creates or replaces the carousel document for a post. The post
// must exist — the carousels.post_id foreign key enforces it, and a violation
// surfaces as 404 rather than 500.
func (h *CarouselHandler) SaveCarousel(c echo.Context) error {
	postID, err := postParam(c)
	if err != nil {
		return err
	}

	var req carouselRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}
	if len(req.Doc) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "doc is required")
	}
	if !isJSONObject(req.Doc) {
		return echo.NewHTTPError(http.StatusBadRequest, "doc must be a JSON object")
	}

	row, err := h.repo.UpsertCarousel(c.Request().Context(), models.UpsertCarouselParams{
		PostID: postID,
		Doc:    string(req.Doc),
	})
	if isForeignKeyViolation(err) {
		return echo.NewHTTPError(http.StatusNotFound, "post not found")
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newCarouselResponse(row))
}

// DeleteCarousel removes a post's carousel document. Idempotent: deleting a
// carousel that is not there still answers 204.
func (h *CarouselHandler) DeleteCarousel(c echo.Context) error {
	postID, err := postParam(c)
	if err != nil {
		return err
	}
	if err := h.repo.DeleteCarouselByPostID(c.Request().Context(), postID); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// isJSONObject reports whether raw is a syntactically valid JSON object ({...}),
// not an array, string, number, or null.
func isJSONObject(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var obj map[string]json.RawMessage
	return json.Unmarshal(raw, &obj) == nil
}

// isForeignKeyViolation reports whether err is a SQLite foreign-key constraint
// failure — the shape UpsertCarousel returns when post_id names no post.
func isForeignKeyViolation(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "foreign key")
}
