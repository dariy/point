package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
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
// The same handler also serves the template store (carousel_templates), keyed
// by slug rather than by post and holding the same opaque envelopes.
//
// Every route is gated in routes.go by RequirePlugin("carousel") ahead of
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

// ── Templates ────────────────────────────────────────────────────────────────

// maxTemplateDocBytes caps one stored template envelope at 8 MB. A template
// inlines its assets as data: URLs, so the envelope is the whole payload and
// nothing bounds it but this. The browser checks before uploading, but the cap
// has to hold here: a limit only the client enforces is not a limit. The global
// BodyLimit middleware sits at the media-upload ceiling (50 MB by default),
// which is far too loose for a row that every template list has to step over.
const maxTemplateDocBytes = 8 << 20

// templateSlugPattern is the url-safe slug: lowercase alphanumerics, hyphen and
// underscore inside, alphanumeric at both ends. It is the character set
// utils.Slugify emits, so a name run through Slugify always passes.
var templateSlugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$`)

// carouselTemplateResponse is the wire shape for a single template: the stored
// envelope parsed back into JSON, as with carouselResponse.
type carouselTemplateResponse struct {
	Slug      string          `json:"slug"`
	Name      string          `json:"name"`
	Doc       json.RawMessage `json:"doc"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
}

// carouselTemplateSummary is one row of the gallery listing. It carries no doc
// on purpose — see the ListCarouselTemplates query.
type carouselTemplateSummary struct {
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

// carouselTemplateRequest carries slug and name beside the envelope even though
// the envelope (toTemplate in document.js) holds an id and a name of its own.
// Reading them out of the envelope would mean parsing it here, and the whole
// point of the opaque contract is that Go never looks inside — so the caller
// states them, they become columns, and the listing can name templates without
// touching a single stored asset.
type carouselTemplateRequest struct {
	Slug string          `json:"slug"`
	Name string          `json:"name"`
	Doc  json.RawMessage `json:"doc"`
}

func newCarouselTemplateResponse(row models.CarouselTemplate) carouselTemplateResponse {
	return carouselTemplateResponse{
		Slug:      row.Slug,
		Name:      row.Name,
		Doc:       json.RawMessage(row.Doc),
		CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// ListCarouselTemplates returns every template as name and slug only, never the
// envelopes.
func (h *CarouselHandler) ListCarouselTemplates(c echo.Context) error {
	rows, err := h.repo.ListCarouselTemplates(c.Request().Context())
	if err != nil {
		return err
	}
	out := make([]carouselTemplateSummary, 0, len(rows))
	for _, row := range rows {
		out = append(out, carouselTemplateSummary{
			Slug:      row.Slug,
			Name:      row.Name,
			CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	return c.JSON(http.StatusOK, out)
}

// GetCarouselTemplate returns one template envelope in full.
func (h *CarouselHandler) GetCarouselTemplate(c echo.Context) error {
	row, err := h.repo.GetCarouselTemplateBySlug(c.Request().Context(), c.Param("slug"))
	if errors.Is(err, sql.ErrNoRows) {
		return echo.NewHTTPError(http.StatusNotFound, "template not found")
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newCarouselTemplateResponse(row))
}

// SaveCarouselTemplate stores a template under its slug, replacing any template
// already there. The replace is what makes "save as template" idempotent: the
// studio can send the same slug twice without first asking whether it exists.
func (h *CarouselHandler) SaveCarouselTemplate(c echo.Context) error {
	var req carouselTemplateRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	slug := strings.TrimSpace(req.Slug)
	if slug == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "slug is required")
	}
	if !templateSlugPattern.MatchString(slug) {
		return echo.NewHTTPError(http.StatusBadRequest,
			"slug must be lowercase letters, digits, hyphen or underscore, and start and end with a letter or digit")
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "name is required")
	}
	if len(name) > 200 {
		return echo.NewHTTPError(http.StatusBadRequest, "name must be 200 characters or fewer")
	}

	if len(req.Doc) == 0 {
		return echo.NewHTTPError(http.StatusBadRequest, "doc is required")
	}
	if len(req.Doc) > maxTemplateDocBytes {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge,
			"template is larger than the 8 MB limit; remove or shrink its inlined assets")
	}
	if !isJSONObject(req.Doc) {
		return echo.NewHTTPError(http.StatusBadRequest, "doc must be a JSON object")
	}

	row, err := h.repo.UpsertCarouselTemplate(c.Request().Context(), models.UpsertCarouselTemplateParams{
		Slug: slug,
		Name: name,
		Doc:  string(req.Doc),
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newCarouselTemplateResponse(row))
}

// DeleteCarouselTemplate removes a template. Idempotent, like DeleteCarousel:
// deleting one that is not there still answers 204.
func (h *CarouselHandler) DeleteCarouselTemplate(c echo.Context) error {
	if err := h.repo.DeleteCarouselTemplate(c.Request().Context(), c.Param("slug")); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
