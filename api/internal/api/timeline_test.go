package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func setupTimelineHandler(t *testing.T) (*TimelineHandler, *services.TimelineService, *services.SettingsService, *services.TagService, repository.Repository) {
	repo := setupTestDB(t)
	// Ensure system tags
	_ = repo.EnsureSystemTags(context.Background())

	timelineSvc := services.NewTimelineService(repo)
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	handler := NewTimelineHandler(timelineSvc, settingsSvc)
	return handler, timelineSvc, settingsSvc, tagSvc, repo
}

func TestTimelineHandler_Gating(t *testing.T) {
	handler, _, settingsSvc, _, repo := setupTimelineHandler(t)
	defer func() { _ = repo.Close() }()
	e := echo.New()
	ctx := context.Background()

	tests := []struct {
		name       string
		mode       string
		isUser     bool
		wantStatus int
	}{
		{"off for guest", "off", false, http.StatusNotFound},
		{"off for admin", "off", true, http.StatusNotFound},
		{"hidden for guest", "hidden", false, http.StatusNotFound},
		{"hidden for admin", "hidden", true, http.StatusOK},
		{"all for guest", "all", false, http.StatusOK},
		{"all for admin", "all", true, http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_ = settingsSvc.SetSetting(ctx, "timeline_mode", tt.mode, "string")

			// Need some data so it doesn't 404 on "empty timeline"
			// Actually h.GetTimeline returns 404 if len(pills) == 0.
			// Let's seed a pill.
			_, _ = repo.DB().Exec(`INSERT OR IGNORE INTO tags (name, slug, kind) VALUES ('2024', '2024', 'year')`)

			req := httptest.NewRequest(http.MethodGet, "/api/timeline", nil)
			rec := httptest.NewRecorder()
			c := e.NewContext(req, rec)
			if tt.isUser {
				c.Set("user", "test-user")
			}

			err := handler.GetTimeline(c)
			if err != nil {
				he, ok := err.(*echo.HTTPError)
				if ok {
					if he.Code != tt.wantStatus {
						t.Errorf("expected status %d, got %d", tt.wantStatus, he.Code)
					}
				} else {
					t.Errorf("unexpected error: %v", err)
				}
			} else {
				if rec.Code != tt.wantStatus {
					t.Errorf("expected status %d, got %d", tt.wantStatus, rec.Code)
				}
			}
		})
	}
}

func TestTimelineHandler_Payload(t *testing.T) {
	handler, _, settingsSvc, _, repo := setupTimelineHandler(t)
	defer func() { _ = repo.Close() }()
	e := echo.New()
	ctx := context.Background()

	_ = settingsSvc.SetSetting(ctx, "timeline_mode", "all", "string")

	// Seed data
	_, _ = repo.DB().Exec(`INSERT OR IGNORE INTO tags (name, slug, kind) VALUES ('2024', '2024', 'year')`)

	req := httptest.NewRequest(http.MethodGet, "/api/timeline", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetTimeline(c); err != nil {
		t.Fatalf("GetTimeline failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var payload services.TimelinePayload
	_ = json.Unmarshal(rec.Body.Bytes(), &payload)

	if len(payload.Pills) != 1 || payload.Pills[0].Slug != "2024" {
		t.Errorf("unexpected payload: %+v", payload)
	}
}
