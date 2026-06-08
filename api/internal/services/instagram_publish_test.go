package services

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/models"
)

func mockSettings(data map[string]string) *SettingsService {
	repo := &mockRepository{
		MockGetSecret: func(_ context.Context, key string) (models.BlogSecret, error) {
			if val, ok := data[key]; ok {
				return models.BlogSecret{Key: key, Value: sql.NullString{String: val, Valid: true}}, nil
			}
			return models.BlogSecret{}, fmt.Errorf("secret not found")
		},
		MockGetSetting: func(_ context.Context, key string) (models.BlogSetting, error) {
			if val, ok := data[key]; ok {
				return models.BlogSetting{Key: key, Value: sql.NullString{String: val, Valid: true}}, nil
			}
			return models.BlogSetting{}, fmt.Errorf("setting not found")
		},
	}
	return NewSettingsService(repo)
}

func TestPostService_CrossPostToInstagram(t *testing.T) {
	ctx := context.Background()

	t.Run("Success Single Image", func(t *testing.T) {
		data := map[string]string{
			"instagram_access_token": "test-token",
			"instagram_user_id":      "ig-user-id",
			"app_url":                "https://example.com",
		}

		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost {
				if r.URL.Path == "/ig-user-id/media" {
					w.Write([]byte(`{"id": "creation-id"}`))
					return
				}
				if r.URL.Path == "/ig-user-id/media_publish" {
					w.Write([]byte(`{"id": "media-id"}`))
					return
				}
			}
			http.Error(w, "not found", http.StatusNotFound)
		})

		ts := httptest.NewServer(handler)
		defer ts.Close()

		settingsSvc := mockSettings(data)
		igSvc := NewInstagramService(settingsSvc).withBaseURL(ts.URL)

		repo := &mockRepository{
			MockGetPost: func(_ context.Context, id int64) (models.Post, error) {
				return models.Post{
					ID:             id,
					Title:          "Test Post",
					Slug:           "test-post",
					InstagramShare: true,
				}, nil
			},
			MockGetMediaByPostID: func(_ context.Context, postID sql.NullInt64) ([]models.Medium, error) {
				return []models.Medium{
					{OriginalPath: "/2026/06/test.jpg"},
				}, nil
			},
			MockGetTagsForPost: func(_ context.Context, postID int64) ([]models.Tag, error) {
				return []models.Tag{{Name: "test"}}, nil
			},
			MockUpdatePostInstagramStatus: func(_ context.Context, arg models.UpdatePostInstagramStatusParams) error {
				if arg.InstagramStatus != "published" {
					t.Errorf("expected status published, got %s", arg.InstagramStatus)
				}
				if arg.InstagramMediaID.String != "media-id" {
					t.Errorf("expected media-id, got %s", arg.InstagramMediaID.String)
				}
				return nil
			},
		}

		postSvc := NewPostService(repo, settingsSvc, igSvc)
		err := postSvc.CrossPostToInstagram(ctx, 1)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("Success Carousel", func(t *testing.T) {
		data := map[string]string{
			"instagram_access_token": "test-token",
			"instagram_user_id":      "ig-user-id",
			"app_url":                "https://example.com",
		}

		childCount := 0
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost {
				_ = r.ParseForm()
				if r.URL.Path == "/ig-user-id/media" {
					if r.Form.Get("is_carousel_item") == "true" {
						childCount++
						w.Write([]byte(fmt.Sprintf(`{"id": "child-id-%d"}`, childCount)))
						return
					}
					w.Write([]byte(`{"id": "carousel-creation-id"}`))
					return
				}
				if r.URL.Path == "/ig-user-id/media_publish" {
					w.Write([]byte(`{"id": "media-id"}`))
					return
				}
			}
			http.Error(w, "not found", http.StatusNotFound)
		})

		ts := httptest.NewServer(handler)
		defer ts.Close()

		settingsSvc := mockSettings(data)
		igSvc := NewInstagramService(settingsSvc).withBaseURL(ts.URL)

		repo := &mockRepository{
			MockGetPost: func(_ context.Context, id int64) (models.Post, error) {
				return models.Post{
					ID:             id,
					Title:          "Test Carousel",
					Slug:           "test-carousel",
					InstagramShare: true,
				}, nil
			},
			MockGetMediaByPostID: func(_ context.Context, postID sql.NullInt64) ([]models.Medium, error) {
				return []models.Medium{
					{OriginalPath: "/2026/06/test1.jpg"},
					{OriginalPath: "/2026/06/test2.jpg"},
				}, nil
			},
			MockGetTagsForPost: func(_ context.Context, postID int64) ([]models.Tag, error) {
				return []models.Tag{{Name: "test"}}, nil
			},
			MockUpdatePostInstagramStatus: func(_ context.Context, arg models.UpdatePostInstagramStatusParams) error {
				if arg.InstagramStatus != "published" {
					t.Errorf("expected status published, got %s", arg.InstagramStatus)
				}
				return nil
			},
		}

		postSvc := NewPostService(repo, settingsSvc, igSvc)
		err := postSvc.CrossPostToInstagram(ctx, 1)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if childCount != 2 {
			t.Errorf("expected 2 carousel children, got %d", childCount)
		}
	})

	t.Run("Failure - Localhost APP_URL", func(t *testing.T) {
		data := map[string]string{
			"app_url": "http://localhost:8080",
		}

		settingsSvc := mockSettings(data)
		repo := &mockRepository{
			MockGetPost: func(_ context.Context, id int64) (models.Post, error) {
				return models.Post{ID: id, InstagramShare: true}, nil
			},
			MockUpdatePostInstagramStatus: func(_ context.Context, arg models.UpdatePostInstagramStatusParams) error {
				if arg.InstagramStatus != "error" {
					t.Errorf("expected status error, got %s", arg.InstagramStatus)
				}
				if arg.InstagramError.String == "" {
					t.Errorf("expected error message")
				}
				return nil
			},
		}

		postSvc := NewPostService(repo, settingsSvc, nil)
		err := postSvc.CrossPostToInstagram(ctx, 1)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}
