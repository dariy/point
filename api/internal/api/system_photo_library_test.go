package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// statsImportConfigured runs GetStats and returns its import_configured flag.
func statsImportConfigured(t *testing.T, h *SystemHandler) bool {
	t.Helper()
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(httptest.NewRequest(http.MethodGet, "/api/system/stats", nil), rec)
	if err := h.GetStats(c); err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	var res map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	v, ok := res["import_configured"].(bool)
	if !ok {
		t.Fatalf("import_configured missing or not bool: %v", res["import_configured"])
	}
	return v
}

func TestPhotoLibraryConfigured_EnvCases(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.jpg")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		path string
		want bool
	}{
		{"env not set", "", false},
		{"missing path", filepath.Join(dir, "missing"), false},
		{"path is a file", file, false},
		{"valid directory", dir, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newSystemHandler(t)
			h.WithPhotoLibraryPath(tc.path)
			if got := statsImportConfigured(t, h); got != tc.want {
				t.Errorf("import_configured = %v, want %v", got, tc.want)
			}
			c := echo.New().NewContext(httptest.NewRequest(http.MethodGet, "/api/system/photo-library", nil), httptest.NewRecorder())
			err := h.GetPhotoLibraryContents(c)
			var he *echo.HTTPError
			if tc.want {
				if err != nil {
					t.Errorf("contents: unexpected error %v", err)
				}
			} else if !errors.As(err, &he) || he.Code != http.StatusBadRequest {
				t.Errorf("contents: want 400, got %v", err)
			}
		})
	}
}

// A path left in blog_secrets by an old version must not turn the library on.
func TestPhotoLibraryConfigured_IgnoresStaleSecret(t *testing.T) {
	h, _ := newSystemHandler(t)
	if err := services.NewSettingsService(h.repo).SetSecret(context.Background(), "photo_library_path", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if statsImportConfigured(t, h) {
		t.Error("import_configured must be false when PHOTO_LIBRARY_PATH is not set")
	}
}

func TestGetPhotoLibraryStatus(t *testing.T) {
	ctx := context.Background()
	h, _ := newSystemHandler(t)
	owner, err := h.repo.CreateUser(ctx, models.CreateUserParams{Username: "owner", Email: "o@x", PasswordHash: "h", DisplayName: "O"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := h.repo.CreateUser(ctx, models.CreateUserParams{Username: "other", Email: "a@x", PasswordHash: "h", DisplayName: "A"})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()

	call := func(principal interface{}) (*httptest.ResponseRecorder, error) {
		rec := httptest.NewRecorder()
		c := echo.New().NewContext(httptest.NewRequest(http.MethodGet, "/api/system/photo-library/status", nil), rec)
		c.Set("user", principal)
		return rec, h.GetPhotoLibraryStatus(c)
	}
	wantCode := func(t *testing.T, err error, code int) {
		t.Helper()
		var he *echo.HTTPError
		if !errors.As(err, &he) || he.Code != code {
			t.Errorf("want %d, got %v", code, err)
		}
	}

	t.Run("not configured is 404 even for the owner", func(t *testing.T) {
		_, err := call(models.GetSessionByTokenRow{UserID: owner.ID})
		wantCode(t, err, http.StatusNotFound)
	})

	h.WithPhotoLibraryPath(dir)

	t.Run("owner sees path", func(t *testing.T) {
		rec, err := call(models.GetSessionByTokenRow{UserID: owner.ID})
		if err != nil {
			t.Fatal(err)
		}
		var res map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if res["configured"] != true || res["path"] != dir {
			t.Errorf("unexpected body %s", rec.Body.String())
		}
	})
	t.Run("other user is 403", func(t *testing.T) {
		_, err := call(models.GetSessionByTokenRow{UserID: other.ID})
		wantCode(t, err, http.StatusForbidden)
	})
	t.Run("api key of the owner is 403", func(t *testing.T) {
		_, err := call(models.GetAPIKeyByHashRow{UserID: owner.ID})
		wantCode(t, err, http.StatusForbidden)
	})
}
