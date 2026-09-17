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
		{"block with a space", "post=1&block=c%207f3a", "", h.GetCarousel, http.StatusBadRequest},
		{"block starting with a hyphen", "post=1&block=-c7f3a", "", h.GetCarousel, http.StatusBadRequest},
		{"block with a slash", "post=1&block=c/7f3a", "", h.GetCarousel, http.StatusBadRequest},
		{"block too long", "post=1&block=c" + strings.Repeat("a", 64), "", h.GetCarousel, http.StatusBadRequest},
		{"block rejected on save too", "post=1&block=c%207f3a", `{"doc":{"version":1}}`, h.SaveCarousel, http.StatusBadRequest},
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

// Several carousels in one post is the whole point of keying rows by block:
// each one round-trips on its own, a save to one leaves the others alone, and
// delete reaches only the block it names.
func TestCarouselHandler_BlocksAreIndependent(t *testing.T) {
	h, _ := newCarouselHandler(t)

	const (
		first  = "post=1&block=c-7f3a"
		second = "post=1&block=c-91b0"
	)

	for _, q := range []string{first, second} {
		if rec := drive(t, h.GetCarousel, http.MethodGet, q, ""); rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s before save: want 404, got %d", q, rec.Code)
		}
	}

	// Two blocks, two documents.
	if rec := drive(t, h.SaveCarousel, http.MethodPut, first, `{"doc":{"version":1,"aspect":"4:5"}}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT first: %d (%s)", rec.Code, rec.Body.String())
	}
	if rec := drive(t, h.SaveCarousel, http.MethodPut, second, `{"doc":{"version":1,"aspect":"1:1"}}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT second: %d (%s)", rec.Code, rec.Body.String())
	}

	// Each reads back its own, and says which block it is.
	if got := getBlock(t, h, first); got.BlockKey != "c-7f3a" || string(got.Doc) != `{"version":1,"aspect":"4:5"}` {
		t.Fatalf("GET first returned %+v", got)
	}
	if got := getBlock(t, h, second); got.BlockKey != "c-91b0" || string(got.Doc) != `{"version":1,"aspect":"1:1"}` {
		t.Fatalf("GET second returned %+v", got)
	}

	// Saving one block does not touch the other.
	if rec := drive(t, h.SaveCarousel, http.MethodPut, first, `{"doc":{"version":2}}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT first again: %d", rec.Code)
	}
	if got := getBlock(t, h, second); string(got.Doc) != `{"version":1,"aspect":"1:1"}` {
		t.Fatalf("saving the first block rewrote the second: %s", got.Doc)
	}

	// Delete is block-scoped.
	if rec := drive(t, h.DeleteCarousel, http.MethodDelete, second, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE second: %d", rec.Code)
	}
	if rec := drive(t, h.GetCarousel, http.MethodGet, second, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("GET second after delete: want 404, got %d", rec.Code)
	}
	if got := getBlock(t, h, first); string(got.Doc) != `{"version":2}` {
		t.Fatalf("deleting the second block took the first with it: %+v", got)
	}
}

// A request with no ?block= is the pre-block-key API, and it has to keep
// addressing a row rather than creating a second one beside the post's
// carousel: on an empty post it saves under the keyless key, and once a block
// has a real key it resolves to that row.
func TestCarouselHandler_UnkeyedRequestsResolveToTheFirstBlock(t *testing.T) {
	h, repo := newCarouselHandler(t)

	// Nothing stored: an unkeyed save is the keyless row the migration's
	// backfill produces.
	if rec := drive(t, h.SaveCarousel, http.MethodPut, "post=1", `{"doc":{"version":1}}`); rec.Code != http.StatusOK {
		t.Fatalf("unkeyed PUT: %d (%s)", rec.Code, rec.Body.String())
	}
	if got := getBlock(t, h, "post=1"); got.BlockKey != "" {
		t.Fatalf("unkeyed PUT stored block_key %q, want the keyless one", got.BlockKey)
	}
	// An explicitly empty block= is the same request, not a different key.
	if got := getBlock(t, h, "post=1&block="); got.BlockKey != "" || string(got.Doc) != `{"version":1}` {
		t.Fatalf("block= (empty) resolved elsewhere: %+v", got)
	}

	// Once that block carries a key, an unkeyed caller lands on its row rather
	// than starting a second one.
	if _, err := repo.DB().Exec(`UPDATE carousels SET block_key = 'c-7f3a' WHERE post_id = 1`); err != nil {
		t.Fatalf("rekey the row: %v", err)
	}
	got := getBlock(t, h, "post=1")
	if got.BlockKey != "c-7f3a" || string(got.Doc) != `{"version":1}` {
		t.Fatalf("unkeyed GET after rekey: %+v", got)
	}
	if rec := drive(t, h.SaveCarousel, http.MethodPut, "post=1", `{"doc":{"version":2}}`); rec.Code != http.StatusOK {
		t.Fatalf("unkeyed PUT after rekey: %d", rec.Code)
	}
	var n int
	if err := repo.DB().QueryRow(`SELECT COUNT(*) FROM carousels WHERE post_id = 1`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("the unkeyed save made a second row: %d rows", n)
	}
	if got := getBlock(t, h, "post=1&block=c-7f3a"); string(got.Doc) != `{"version":2}` {
		t.Fatalf("the unkeyed save missed the keyed row: %s", got.Doc)
	}

	// ...and an unkeyed delete reaches it too.
	if rec := drive(t, h.DeleteCarousel, http.MethodDelete, "post=1", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("unkeyed DELETE: %d", rec.Code)
	}
	if rec := drive(t, h.GetCarousel, http.MethodGet, "post=1&block=c-7f3a", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("after unkeyed DELETE: want 404, got %d", rec.Code)
	}
}

// getBlock GETs one row and decodes it, failing the test on anything but 200.
func getBlock(t *testing.T, h *CarouselHandler, query string) carouselResponse {
	t.Helper()
	rec := drive(t, h.GetCarousel, http.MethodGet, query, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: want 200, got %d (%s)", query, rec.Code, rec.Body.String())
	}
	var got carouselResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode GET %s: %v", query, err)
	}
	return got
}

// ── Templates ────────────────────────────────────────────────────────────────

// driveTemplate runs one template handler method. slug, when non-empty, is set
// as the :slug path parameter the routes declare.
func driveTemplate(t *testing.T, fn func(echo.Context) error, method, slug, body string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/api/carousel/templates", nil)
	} else {
		r = httptest.NewRequest(method, "/api/carousel/templates", strings.NewReader(body))
		r.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(r, rec)
	if slug != "" {
		c.SetParamNames("slug")
		c.SetParamValues(slug)
	}
	if err := fn(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func TestCarouselTemplates_RoundTrip(t *testing.T) {
	h, _ := newCarouselHandler(t)

	// Empty store lists as [], not null — a gallery iterating the response
	// should not have to special-case a missing array.
	rec := driveTemplate(t, h.ListCarouselTemplates, http.MethodGet, "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("LIST empty: want 200, got %d", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Fatalf("LIST empty: want [], got %s", got)
	}
	if rec := driveTemplate(t, h.GetCarouselTemplate, http.MethodGet, "nope", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("GET absent: want 404, got %d", rec.Code)
	}

	// Save two.
	rec = driveTemplate(t, h.SaveCarouselTemplate, http.MethodPost, "",
		`{"slug":"zine","name":"Zine","doc":{"version":1,"aspect":"4:5"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var saved carouselTemplateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
		t.Fatalf("decode POST response: %v", err)
	}
	if saved.Slug != "zine" || saved.Name != "Zine" || string(saved.Doc) != `{"version":1,"aspect":"4:5"}` {
		t.Fatalf("POST echoed %+v", saved)
	}
	if rec := driveTemplate(t, h.SaveCarouselTemplate, http.MethodPost, "",
		`{"slug":"album","name":"Album","doc":{"version":1}}`); rec.Code != http.StatusOK {
		t.Fatalf("POST second: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	// The listing is ordered by name and carries no doc at all — the whole
	// reason ListCarouselTemplates names its columns.
	rec = driveTemplate(t, h.ListCarouselTemplates, http.MethodGet, "", "")
	var list []carouselTemplateSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode LIST: %v", err)
	}
	if len(list) != 2 || list[0].Slug != "album" || list[1].Slug != "zine" {
		t.Fatalf("LIST returned %+v", list)
	}
	if strings.Contains(rec.Body.String(), "aspect") || strings.Contains(rec.Body.String(), `"doc"`) {
		t.Fatalf("LIST leaked the envelope: %s", rec.Body.String())
	}

	// Get one back in full.
	rec = driveTemplate(t, h.GetCarouselTemplate, http.MethodGet, "zine", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: want 200, got %d", rec.Code)
	}
	var got carouselTemplateResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if string(got.Doc) != `{"version":1,"aspect":"4:5"}` {
		t.Fatalf("GET returned doc %s", got.Doc)
	}

	// A POST of an existing slug replaces it rather than erroring, and does
	// not add a row — that is what makes "save as template" idempotent.
	rec = driveTemplate(t, h.SaveCarouselTemplate, http.MethodPost, "",
		`{"slug":"zine","name":"Zine v2","doc":{"version":1,"aspect":"1:1"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST replace: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	rec = driveTemplate(t, h.GetCarouselTemplate, http.MethodGet, "zine", "")
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Name != "Zine v2" || !strings.Contains(string(got.Doc), `"1:1"`) {
		t.Fatalf("replace did not take: %+v", got)
	}
	rec = driveTemplate(t, h.ListCarouselTemplates, http.MethodGet, "", "")
	list = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 2 {
		t.Fatalf("replace added a row: %+v", list)
	}

	// Delete, then a second delete is still fine.
	if rec := driveTemplate(t, h.DeleteCarouselTemplate, http.MethodDelete, "zine", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE: want 204, got %d", rec.Code)
	}
	if rec := driveTemplate(t, h.DeleteCarouselTemplate, http.MethodDelete, "zine", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("idempotent DELETE: want 204, got %d", rec.Code)
	}
	if rec := driveTemplate(t, h.GetCarouselTemplate, http.MethodGet, "zine", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("GET after delete: want 404, got %d", rec.Code)
	}
}

// The envelope is opaque to Go: whatever the frontend puts in comes back byte
// for byte, unknown fields and all. This is the contract that has let the
// carousel document evolve through S2 and S3 without a Go change.
func TestCarouselTemplates_OpaqueEnvelope(t *testing.T) {
	h, _ := newCarouselHandler(t)

	const doc = `{"version":99,"unknownFuture":{"nested":[1,2,{"deep":null}]},"emoji":"🎠","zeroKept":0.50}`
	if rec := driveTemplate(t, h.SaveCarouselTemplate, http.MethodPost, "",
		`{"slug":"opaque","name":"Opaque","doc":`+doc+`}`); rec.Code != http.StatusOK {
		t.Fatalf("POST: want 200, got %d", rec.Code)
	}

	rec := driveTemplate(t, h.GetCarouselTemplate, http.MethodGet, "opaque", "")
	var got carouselTemplateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode GET: %v", err)
	}
	if string(got.Doc) != doc {
		t.Fatalf("envelope was rewritten:\n want %s\n  got %s", doc, got.Doc)
	}
}

// The 8 MB cap is the server's, not the browser's: it has to hold against a
// request that never went through the studio.
func TestCarouselTemplates_SizeCap(t *testing.T) {
	h, _ := newCarouselHandler(t)

	// Just under: a valid object whose doc is one byte inside the cap.
	const overhead = len(`{"blob":""}`)
	under := `{"blob":"` + strings.Repeat("x", maxTemplateDocBytes-overhead) + `"}`
	if len(under) != maxTemplateDocBytes {
		t.Fatalf("test built a %d-byte doc, want %d", len(under), maxTemplateDocBytes)
	}
	if rec := driveTemplate(t, h.SaveCarouselTemplate, http.MethodPost, "",
		`{"slug":"big","name":"Big","doc":`+under+`}`); rec.Code != http.StatusOK {
		t.Fatalf("doc at the cap: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	// One byte over.
	over := `{"blob":"` + strings.Repeat("x", maxTemplateDocBytes-overhead+1) + `"}`
	rec := driveTemplate(t, h.SaveCarouselTemplate, http.MethodPost, "",
		`{"slug":"toobig","name":"Too big","doc":`+over+`}`)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("doc over the cap: want 413, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "8 MB") {
		t.Fatalf("413 message does not name the limit: %s", rec.Body.String())
	}
	if rec := driveTemplate(t, h.GetCarouselTemplate, http.MethodGet, "toobig", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("rejected template was stored anyway: %d", rec.Code)
	}
}

func TestCarouselTemplates_BadRequests(t *testing.T) {
	h, _ := newCarouselHandler(t)

	cases := []struct {
		name, body string
		want       int
	}{
		{"slug missing", `{"name":"N","doc":{"version":1}}`, http.StatusBadRequest},
		{"slug blank", `{"slug":"  ","name":"N","doc":{"version":1}}`, http.StatusBadRequest},
		{"slug uppercase", `{"slug":"Zine","name":"N","doc":{"version":1}}`, http.StatusBadRequest},
		{"slug spaced", `{"slug":"my zine","name":"N","doc":{"version":1}}`, http.StatusBadRequest},
		{"slug path traversal", `{"slug":"../etc/passwd","name":"N","doc":{"version":1}}`, http.StatusBadRequest},
		{"slug leading hyphen", `{"slug":"-zine","name":"N","doc":{"version":1}}`, http.StatusBadRequest},
		{"slug trailing hyphen", `{"slug":"zine-","name":"N","doc":{"version":1}}`, http.StatusBadRequest},
		{"name missing", `{"slug":"zine","doc":{"version":1}}`, http.StatusBadRequest},
		{"name blank", `{"slug":"zine","name":" ","doc":{"version":1}}`, http.StatusBadRequest},
		{"doc missing", `{"slug":"zine","name":"N"}`, http.StatusBadRequest},
		{"doc is array", `{"slug":"zine","name":"N","doc":[1,2]}`, http.StatusBadRequest},
		{"doc is string", `{"slug":"zine","name":"N","doc":"x"}`, http.StatusBadRequest},
		{"doc malformed", `{"slug":"zine","name":"N","doc":{`, http.StatusBadRequest},
		{"name over 200 chars", `{"slug":"zine","name":"` + strings.Repeat("n", 201) + `","doc":{"version":1}}`, http.StatusBadRequest},
		{"slug with underscore is fine", `{"slug":"my_zine-2","name":"N","doc":{"version":1}}`, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := driveTemplate(t, h.SaveCarouselTemplate, http.MethodPost, "", tc.body)
			if rec.Code != tc.want {
				t.Fatalf("want %d, got %d (%s)", tc.want, rec.Code, rec.Body.String())
			}
		})
	}
}

// Every template route propagates a repository failure rather than swallowing
// it into an empty 200. Dropping the table is the same trick
// TestGetTagsPage_DBError uses, and it reaches all four handlers at once —
// including the non-ErrNoRows arm of GetCarouselTemplate, which a missing row
// alone does not exercise.
func TestCarouselTemplates_DBError(t *testing.T) {
	h, repo := newCarouselHandler(t)
	if _, err := repo.DB().Exec(`DROP TABLE carousel_templates`); err != nil {
		t.Fatalf("drop carousel_templates: %v", err)
	}

	cases := []struct {
		name   string
		fn     func(echo.Context) error
		method string
		slug   string
		body   string
	}{
		{"list", h.ListCarouselTemplates, http.MethodGet, "", ""},
		{"get", h.GetCarouselTemplate, http.MethodGet, "zine", ""},
		{"save", h.SaveCarouselTemplate, http.MethodPost, "", `{"slug":"zine","name":"Zine","doc":{"version":1}}`},
		{"delete", h.DeleteCarouselTemplate, http.MethodDelete, "zine", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := driveTemplate(t, tc.fn, tc.method, tc.slug, tc.body)
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("want 500, got %d (%s)", rec.Code, rec.Body.String())
			}
		})
	}
}
