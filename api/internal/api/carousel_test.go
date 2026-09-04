package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
)

func newCarouselHandler(t *testing.T) (*CarouselHandler, repository.Repository) {
	t.Helper()
	repo := setupTestDB(t)
	insertUser(repo)
	if _, err := repo.DB().Exec(
		`INSERT INTO posts (id,title,slug,content,author_id,status) VALUES (1,'P','p','body',1,'draft')`,
	); err != nil {
		t.Fatalf("seed post: %v", err)
	}
	return NewCarouselHandler(repo), repo
}

// drive runs one handler method against ?post=<query> with an optional JSON body.
func drive(t *testing.T, fn func(echo.Context) error, method, query, body string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/api/carousel?"+query, nil)
	} else {
		r = httptest.NewRequest(method, "/api/carousel?"+query, strings.NewReader(body))
		r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(r, rec)
	if err := fn(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func TestCarouselHandler_RoundTrip(t *testing.T) {
	h, _ := newCarouselHandler(t)

	// Nothing stored yet.
	if rec := drive(t, h.GetCarousel, http.MethodGet, "post=1", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("GET before save: want 404, got %d", rec.Code)
	}

	// Save.
	rec := drive(t, h.SaveCarousel, http.MethodPut, "post=1", `{"doc":{"version":1,"aspect":"4:5"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var saved carouselResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
		t.Fatalf("decode PUT response: %v", err)
	}
	if saved.PostID != 1 || string(saved.Doc) != `{"version":1,"aspect":"4:5"}` {
		t.Fatalf("PUT echoed %+v", saved)
	}

	// Read it back verbatim.
	rec = drive(t, h.GetCarousel, http.MethodGet, "post=1", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET after save: want 200, got %d", rec.Code)
	}
	var got carouselResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if string(got.Doc) != `{"version":1,"aspect":"4:5"}` {
		t.Fatalf("GET returned doc %s", got.Doc)
	}

	// Second PUT replaces rather than errors.
	rec = drive(t, h.SaveCarousel, http.MethodPut, "post=1", `{"doc":{"version":1,"aspect":"1:1"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT replace: want 200, got %d", rec.Code)
	}
	rec = drive(t, h.GetCarousel, http.MethodGet, "post=1", "")
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if !strings.Contains(string(got.Doc), `"1:1"`) {
		t.Fatalf("replace did not take: %s", got.Doc)
	}

	// Delete, then a second delete is still fine.
	if rec := drive(t, h.DeleteCarousel, http.MethodDelete, "post=1", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE: want 204, got %d", rec.Code)
	}
	if rec := drive(t, h.DeleteCarousel, http.MethodDelete, "post=1", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("idempotent DELETE: want 204, got %d", rec.Code)
	}
	if rec := drive(t, h.GetCarousel, http.MethodGet, "post=1", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("GET after delete: want 404, got %d", rec.Code)
	}
}

func TestCarouselHandler_BadRequests(t *testing.T) {
	h, _ := newCarouselHandler(t)

	cases := []struct {
		name, query, body string
		fn                func(echo.Context) error
		want              int
	}{
		{"missing post param", "", "", h.GetCarousel, http.StatusBadRequest},
		{"non-numeric post", "post=abc", "", h.GetCarousel, http.StatusBadRequest},
		{"zero post", "post=0", "", h.GetCarousel, http.StatusBadRequest},
		{"doc missing", "post=1", `{}`, h.SaveCarousel, http.StatusBadRequest},
		{"doc is array", "post=1", `{"doc":[1,2]}`, h.SaveCarousel, http.StatusBadRequest},
		{"doc is string", "post=1", `{"doc":"x"}`, h.SaveCarousel, http.StatusBadRequest},
		{"doc malformed", "post=1", `{"doc":{`, h.SaveCarousel, http.StatusBadRequest},
		{"post does not exist", "post=999", `{"doc":{"version":1}}`, h.SaveCarousel, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			method := http.MethodGet
			if tc.body != "" {
				method = http.MethodPut
			}
			if rec := drive(t, tc.fn, method, tc.query, tc.body); rec.Code != tc.want {
				t.Fatalf("want %d, got %d (%s)", tc.want, rec.Code, rec.Body.String())
			}
		})
	}
}

// Deleting the post removes its carousel row through ON DELETE CASCADE.
func TestCarouselHandler_PostDeleteCascades(t *testing.T) {
	h, repo := newCarouselHandler(t)

	if rec := drive(t, h.SaveCarousel, http.MethodPut, "post=1", `{"doc":{"version":1}}`); rec.Code != http.StatusOK {
		t.Fatalf("seed carousel: %d", rec.Code)
	}
	if _, err := repo.DB().Exec(`DELETE FROM posts WHERE id = 1`); err != nil {
		t.Fatalf("delete post: %v", err)
	}
	var n int
	if err := repo.DB().QueryRow(`SELECT COUNT(*) FROM carousels`).Scan(&n); err != nil {
		t.Fatalf("count carousels: %v", err)
	}
	if n != 0 {
		t.Fatalf("carousel row survived post deletion: %d rows", n)
	}
}
