package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

// These tests pin the behaviour changes from migrating posts.go onto MapError.
// Before the migration every one of these paths answered 404 on any failure,
// including a dead database, and the 500 paths echoed the driver's message
// straight back to the client.

// statusOf pulls the status out of a handler's returned error.
func statusOf(t *testing.T, err error) (int, interface{}) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error from the handler, got nil")
	}
	var he *echo.HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("handler returned %v (%T), want *echo.HTTPError", err, err)
	}
	return he.Code, he.Message
}

// TestPostHandlerDBFailureIsNot404 covers the paths that used to report a
// missing post when the real problem was the database. A caller cannot act on
// a 404 that actually means "we are broken", and monitoring cannot see it.
func TestPostHandlerDBFailureIsNot404(t *testing.T) {
	cases := []struct {
		name string
		call func(*PostHandler, echo.Context) error
	}{
		{"GetPostByID", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.GetPostByID(c)
		}},
		{"GetPostBySlug", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("slug")
			c.SetParamValues("anything")
			return ph.GetPostBySlug(c)
		}},
		{"UpdatePostStatus", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.UpdatePostStatus(c)
		}},
		{"DeletePost", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.DeletePost(c)
		}},
		{"RestorePost", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.RestorePost(c)
		}},
		{"PermanentlyDeletePost", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.PermanentlyDeletePost(c)
		}},
		{"PublishPost", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.PublishPost(c)
		}},
		{"GeneratePreviewLink", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.GeneratePreviewLink(c)
		}},
		{"GetPostByPreviewToken", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("token")
			c.SetParamValues("sometoken")
			return ph.GetPostByPreviewToken(c)
		}},
		{"GetPostNavigation", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("1")
			return ph.GetPostNavigation(c)
		}},
		{"GetPostAnalytics", func(ph *PostHandler, c echo.Context) error {
			return ph.GetPostAnalytics(c)
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ph, h := setupPostHandler(t)
			_ = h.repo.Close() // the database is now unusable

			e := echo.New()
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"status":"published"}`))
			req.Header.Set("Content-Type", "application/json")
			c := e.NewContext(req, httptest.NewRecorder())

			code, msg := statusOf(t, tc.call(ph, c))
			if code != http.StatusInternalServerError {
				t.Errorf("status = %d, want 500 for a database failure", code)
			}
			// The driver's text must not travel to the client.
			if text, ok := msg.(string); ok && text != "internal server error" {
				t.Errorf("detail = %q, want a generic message", text)
			}
		})
	}
}

// TestPostHandlerMissingPostStill404 is the other half: the statuses that were
// correct before must not have moved.
func TestPostHandlerMissingPostStill404(t *testing.T) {
	cases := []struct {
		name string
		call func(*PostHandler, echo.Context) error
	}{
		{"GetPostByID", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("999999")
			return ph.GetPostByID(c)
		}},
		{"GetPostBySlug", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("slug")
			c.SetParamValues("no-such-post")
			return ph.GetPostBySlug(c)
		}},
		{"UpdatePostStatus", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("999999")
			return ph.UpdatePostStatus(c)
		}},
		{"PublishPost", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("999999")
			return ph.PublishPost(c)
		}},
		{"UpdatePostTags", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("999999")
			return ph.UpdatePostTags(c)
		}},
		// GetPostNavigation reports a missing anchor post through the same
		// sql.ErrNoRows as a read, from a lookup that is easy to mistake for a
		// neighbour query. Having no neighbours is not an error.
		{"GetPostNavigation", func(ph *PostHandler, c echo.Context) error {
			c.SetParamNames("id")
			c.SetParamValues("999999")
			return ph.GetPostNavigation(c)
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ph, h := setupPostHandler(t)
			defer h.close()

			e := echo.New()
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"status":"published","tags":[]}`))
			req.Header.Set("Content-Type", "application/json")
			c := e.NewContext(req, httptest.NewRecorder())

			if code, _ := statusOf(t, tc.call(ph, c)); code != http.StatusNotFound {
				t.Errorf("status = %d, want 404 for a post that does not exist", code)
			}
		})
	}
}

// TestPreviewTokenStaysVague keeps the deliberate wording on this endpoint: a
// bad token and an expired one must be indistinguishable, so neither confirms
// that a draft exists.
func TestPreviewTokenStaysVague(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()

	e := echo.New()
	c := e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), httptest.NewRecorder())
	c.SetParamNames("token")
	c.SetParamValues("not-a-real-token")

	code, msg := statusOf(t, ph.GetPostByPreviewToken(c))
	if code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", code)
	}
	if msg != "invalid or expired preview link" {
		t.Errorf("detail = %v, want the deliberately vague message", msg)
	}
}
