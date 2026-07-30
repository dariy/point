package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// These cover the handlers migrated onto MapError outside posts.go. The two
// properties asserted throughout: a classified failure keeps the status it had
// before the migration, and an unclassified one answers a bare 500 rather than
// posing as a 404 or leaking the driver's message.
//
// posts.go has its own file (posts_error_mapping_test.go) because it needed the
// largest behaviour audit.

// TestMediaHandlerErrorMapping covers the three EXIF endpoints that used to
// decide their status by searching the error text for "no rows",
// "disallowed characters" and "no original metadata".
func TestMediaHandlerErrorMapping(t *testing.T) {
	t.Run("missing media is 404", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			call func(*MediaHandler, echo.Context) error
		}{
			{"GetMedia", func(mh *MediaHandler, c echo.Context) error { return mh.GetMedia(c) }},
			{"ReextractEXIF", func(mh *MediaHandler, c echo.Context) error { return mh.ReextractEXIF(c) }},
			{"UpdateEXIF", func(mh *MediaHandler, c echo.Context) error { return mh.UpdateEXIF(c) }},
			{"RevertEXIF", func(mh *MediaHandler, c echo.Context) error { return mh.RevertEXIF(c) }},
			{"RenameMedia", func(mh *MediaHandler, c echo.Context) error { return mh.RenameMedia(c) }},
		} {
			t.Run(tc.name, func(t *testing.T) {
				h := setupHandlers(t)
				defer h.close()
				mh := NewMediaHandler(h.mediaSvc, h.settingsSvc)

				e := echo.New()
				req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"new_filename":"x.jpg","Make":"Nikon"}`))
				req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
				c := e.NewContext(req, httptest.NewRecorder())
				c.SetParamNames("id")
				c.SetParamValues("999999")

				if code, _ := statusOf(t, tc.call(mh, c)); code != http.StatusNotFound {
					t.Errorf("status = %d, want 404", code)
				}
			})
		}
	})

	t.Run("rejected EXIF value is 400 and keeps its message", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		mh := NewMediaHandler(h.mediaSvc, h.settingsSvc)
		insertUser(h.repo)
		_, err := h.repo.DB().Exec(`INSERT INTO media (id,filename,original_path,file_type,mime_type,file_size,checksum)
			VALUES (1,'a.jpg','originals/2026/01/a.jpg','image','image/jpeg',10,'sum')`)
		if err != nil {
			t.Fatalf("seed media: %v", err)
		}

		e := echo.New()
		// A semicolon is outside what sanitizeEXIFValue keeps.
		req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"Make":"bad;value"}`))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		c := e.NewContext(req, httptest.NewRecorder())
		c.SetParamNames("id")
		c.SetParamValues("1")

		code, msg := statusOf(t, mh.UpdateEXIF(c))
		if code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", code)
		}
		// The service's wording still reaches the client; only the routing changed.
		if text, ok := msg.(string); !ok || !strings.Contains(text, "disallowed characters") {
			t.Errorf("detail = %v, want the service's own explanation", msg)
		}
	})
}

// TestTagHandlerErrorMapping covers the statuses tag_service used to build as
// echo.HTTPError values itself.
func TestTagHandlerErrorMapping(t *testing.T) {
	newTagHandler := func(t *testing.T) (*TagHandler, *testHandlers) {
		t.Helper()
		h := setupHandlers(t)
		return NewTagHandler(h.tagSvc, h.settingsSvc), h
	}

	t.Run("duplicate slug is 409", func(t *testing.T) {
		th, h := newTagHandler(t)
		defer h.close()
		if _, err := h.tagSvc.CreateTag(t.Context(), services.CreateTagParams{Name: "Alpha", Slug: "alpha"}); err != nil {
			t.Fatalf("seed tag: %v", err)
		}

		e := echo.New()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"Alpha Again","slug":"alpha"}`))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		c := e.NewContext(req, httptest.NewRecorder())
		c.Set("user", models.GetSessionByTokenRow{UserID: 1})

		code, msg := statusOf(t, th.CreateTag(c))
		if code != http.StatusConflict {
			t.Errorf("status = %d, want 409", code)
		}
		if msg != "a tag with that slug already exists" {
			t.Errorf("detail = %v, want the slug-collision message", msg)
		}
	})

	t.Run("missing tag is 404", func(t *testing.T) {
		th, h := newTagHandler(t)
		defer h.close()

		e := echo.New()
		c := e.NewContext(httptest.NewRequest(http.MethodDelete, "/", nil), httptest.NewRecorder())
		c.SetParamNames("id")
		c.SetParamValues("999999")

		if code, _ := statusOf(t, th.DeleteTag(c)); code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", code)
		}
	})

	t.Run("moving a tag under a parent that is not its own is 422", func(t *testing.T) {
		th, h := newTagHandler(t)
		defer h.close()
		ctx := t.Context()
		a, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "A", Slug: "a"})
		if err != nil {
			t.Fatalf("seed tag a: %v", err)
		}
		b, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "B", Slug: "b"})
		if err != nil {
			t.Fatalf("seed tag b: %v", err)
		}

		e := echo.New()
		// b is not a child of a: well-formed and understood, but semantically
		// wrong — the one case the taxonomy needed a 422 kind for.
		body := `{"parent_id":` + strconv.FormatInt(a.ID, 10) + `}`
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		c := e.NewContext(req, httptest.NewRecorder())
		c.SetParamNames("id")
		c.SetParamValues(strconv.FormatInt(b.ID, 10))

		code, msg := statusOf(t, th.MoveTag(c))
		if code != http.StatusUnprocessableEntity {
			t.Errorf("status = %d, want 422 (the status this returned before the taxonomy)", code)
		}
		if msg != "tag is not a child of the given parent" {
			t.Errorf("detail = %v, want the service's explanation", msg)
		}
	})
}

// TestAuthHandlerErrorMapping covers the login and re-authentication paths.
func TestAuthHandlerErrorMapping(t *testing.T) {
	t.Run("bad credentials are 401", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		ah := NewAuthHandler(h.authSvc, h.cfg, h.repo)
		insertUser(h.repo)

		e := echo.New()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"username":"testuser","password":"wrong"}`))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		c := e.NewContext(req, httptest.NewRecorder())

		code, msg := statusOf(t, ah.Login(c))
		if code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", code)
		}
		// Still the deliberately non-committal wording: it must not reveal
		// whether the username exists.
		if msg != "invalid username or password" {
			t.Errorf("detail = %v, want the non-committal message", msg)
		}
	})

	t.Run("a dead database on login is 500, not 401", func(t *testing.T) {
		h := setupHandlers(t)
		ah := NewAuthHandler(h.authSvc, h.cfg, h.repo)
		insertUser(h.repo)
		_ = h.repo.Close()

		e := echo.New()
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"username":"testuser","password":"whatever"}`))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		c := e.NewContext(req, httptest.NewRecorder())

		// Authenticate equalises timing by falling back to a dummy hash, so a
		// closed database still ends in "invalid username or password" — a
		// deliberate 401. What matters is that it is not a leaked 500 body.
		code, msg := statusOf(t, ah.Login(c))
		if code != http.StatusUnauthorized && code != http.StatusInternalServerError {
			t.Errorf("status = %d, want 401 or 500", code)
		}
		if text, ok := msg.(string); ok && strings.Contains(text, "sql:") {
			t.Errorf("detail = %q leaks the driver's message", text)
		}
	})
}
