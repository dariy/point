package services

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
					_, _ = w.Write([]byte(`{"id": "creation-id"}`))
					return
				}
				if r.URL.Path == "/ig-user-id/media_publish" {
					_, _ = w.Write([]byte(`{"id": "media-id"}`))
					return
				}
			}
			if r.Method == http.MethodGet && r.URL.Query().Get("fields") != "" {
				_, _ = w.Write([]byte(`{"status_code":"FINISHED"}`))
				return
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
					Content:        "![img](/2026/06/test.jpg)",
				}, nil
			},
			MockGetMediaByPaths: func(_ context.Context, _ []string) ([]models.Medium, error) {
				return []models.Medium{
					{OriginalPath: "originals/2026/06/test.jpg"},
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

		postSvc := NewPostService(repo, settingsSvc, igSvc, ts.URL)
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
						_, _ = fmt.Fprintf(w, `{"id": "child-id-%d"}`, childCount)
						return
					}
					_, _ = w.Write([]byte(`{"id": "carousel-creation-id"}`))
					return
				}
				if r.URL.Path == "/ig-user-id/media_publish" {
					_, _ = w.Write([]byte(`{"id": "media-id"}`))
					return
				}
			}
			if r.Method == http.MethodGet && r.URL.Query().Get("fields") != "" {
				_, _ = w.Write([]byte(`{"status_code":"FINISHED"}`))
				return
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
					Content:        "![img](/2026/06/test1.jpg)\n![img2](/2026/06/test2.jpg)",
				}, nil
			},
			MockGetMediaByPaths: func(_ context.Context, _ []string) ([]models.Medium, error) {
				return []models.Medium{
					{OriginalPath: "originals/2026/06/test1.jpg"},
					{OriginalPath: "originals/2026/06/test2.jpg"},
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

		postSvc := NewPostService(repo, settingsSvc, igSvc, ts.URL)
		err := postSvc.CrossPostToInstagram(ctx, 1)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if childCount != 2 {
			t.Errorf("expected 2 carousel children, got %d", childCount)
		}
	})

	t.Run("Container ERROR marks post error", func(t *testing.T) {
		data := map[string]string{
			"instagram_access_token": "test-token",
			"instagram_user_id":      "ig-user-id",
			"app_url":                "https://example.com",
		}

		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/media") {
				_, _ = w.Write([]byte(`{"id": "creation-id"}`))
				return
			}
			if r.Method == http.MethodGet && r.URL.Query().Get("fields") != "" {
				_, _ = w.Write([]byte(`{"status_code":"ERROR","status":"media processing failed"}`))
				return
			}
			http.Error(w, "not found", http.StatusNotFound)
		})

		ts := httptest.NewServer(handler)
		defer ts.Close()

		settingsSvc := mockSettings(data)
		igSvc := NewInstagramService(settingsSvc).withBaseURL(ts.URL)

		var capturedStatus, capturedError string
		repo := &mockRepository{
			MockGetPost: func(_ context.Context, id int64) (models.Post, error) {
				return models.Post{ID: id, Title: "T", Slug: "t", InstagramShare: true, Content: "![img](/2026/06/test.jpg)"}, nil
			},
			MockGetMediaByPaths: func(_ context.Context, _ []string) ([]models.Medium, error) {
				return []models.Medium{{OriginalPath: "originals/2026/06/test.jpg"}}, nil
			},
			MockGetTagsForPost: func(_ context.Context, _ int64) ([]models.Tag, error) {
				return nil, nil
			},
			MockUpdatePostInstagramStatus: func(_ context.Context, arg models.UpdatePostInstagramStatusParams) error {
				capturedStatus = arg.InstagramStatus
				capturedError = arg.InstagramError.String
				return nil
			},
		}

		postSvc := NewPostService(repo, settingsSvc, igSvc, ts.URL)
		err := postSvc.CrossPostToInstagram(ctx, 1)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if capturedStatus != "error" {
			t.Errorf("expected instagram_status='error', got %q", capturedStatus)
		}
		if !strings.Contains(capturedError, "media processing failed") {
			t.Errorf("expected error text in instagram_error, got %q", capturedError)
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

		postSvc := NewPostService(repo, settingsSvc, nil, "")
		err := postSvc.CrossPostToInstagram(ctx, 1)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}

// igMockServer returns a test HTTP server that handles single-image IG API calls successfully.
func igMockServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/media") {
			_, _ = w.Write([]byte(`{"id":"creation-id"}`))
			return
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/media_publish") {
			_, _ = w.Write([]byte(`{"id":"media-id"}`))
			return
		}
		// Container status poll: GET /{containerID}?fields=status_code,...
		if r.Method == http.MethodGet && r.URL.Query().Get("fields") != "" {
			_, _ = w.Write([]byte(`{"status_code":"FINISHED"}`))
			return
		}
		http.Error(w, "unexpected: "+r.URL.Path, http.StatusInternalServerError)
	}))
}

// igPostSvc wires a PostService with a settings map and an ig test server.
func igPostSvc(settings map[string]string, repo *mockRepository, ts *httptest.Server) *PostService {
	settingsSvc := mockSettings(settings)
	igSvc := NewInstagramService(settingsSvc).withBaseURL(ts.URL)
	return NewPostService(repo, settingsSvc, igSvc, ts.URL)
}

// igShareRepo builds a minimal mockRepository for publish-hook tests.
// The done channel receives the instagram_status from UpdatePostInstagramStatus.
func igShareRepo(shareEnabled bool, done chan<- string) *mockRepository {
	return &mockRepository{
		MockPublishPost: func(_ context.Context, id int64) (models.Post, error) {
			return models.Post{ID: id, InstagramShare: shareEnabled, Content: "![img](/2026/06/test.jpg)"}, nil
		},
		MockGetPost: func(_ context.Context, id int64) (models.Post, error) {
			return models.Post{ID: id, InstagramShare: shareEnabled, Content: "![img](/2026/06/test.jpg)"}, nil
		},
		MockGetMediaByPaths: func(_ context.Context, _ []string) ([]models.Medium, error) {
			return []models.Medium{{OriginalPath: "originals/2026/06/test.jpg"}}, nil
		},
		MockGetTagsForPost: func(_ context.Context, _ int64) ([]models.Tag, error) {
			return nil, nil
		},
		MockUpdatePostInstagramStatus: func(_ context.Context, arg models.UpdatePostInstagramStatusParams) error {
			if done != nil {
				done <- arg.InstagramStatus
			}
			return nil
		},
	}
}

func TestPostService_PublishPost_TriggersInstagramCrossPost(t *testing.T) {
	ts := igMockServer(t)
	defer ts.Close()

	done := make(chan string, 1)
	svc := igPostSvc(map[string]string{
		"enable_instagram":       "true",
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid",
		"app_url":                "https://example.com",
	}, igShareRepo(true, done), ts)

	if _, err := svc.PublishPost(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	select {
	case status := <-done:
		if status != "published" {
			t.Errorf("expected status 'published', got %q", status)
		}
	case <-time.After(2 * time.Second):
		t.Error("CrossPostToInstagram was not triggered within 2 seconds")
	}
}

func TestPostService_PublishPost_SkipsWhenInstagramDisabled(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Instagram API must not be called when enable_instagram=false")
	}))
	defer ts.Close()

	repo := igShareRepo(true, nil)
	repo.MockUpdatePostInstagramStatus = func(_ context.Context, _ models.UpdatePostInstagramStatusParams) error {
		t.Error("UpdatePostInstagramStatus must not be called when enable_instagram=false")
		return nil
	}

	svc := igPostSvc(map[string]string{"enable_instagram": "false"}, repo, ts)
	if _, err := svc.PublishPost(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPostService_PublishPost_SkipsWhenShareOptOut(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Instagram API must not be called when instagram_share=false")
	}))
	defer ts.Close()

	repo := igShareRepo(false, nil)
	repo.MockUpdatePostInstagramStatus = func(_ context.Context, _ models.UpdatePostInstagramStatusParams) error {
		t.Error("UpdatePostInstagramStatus must not be called when instagram_share=false")
		return nil
	}

	svc := igPostSvc(map[string]string{"enable_instagram": "true"}, repo, ts)
	if _, err := svc.PublishPost(context.Background(), 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPostService_PublishDueScheduledPosts_TriggersInstagramCrossPost(t *testing.T) {
	ts := igMockServer(t)
	defer ts.Close()

	done := make(chan string, 1)
	repo := igShareRepo(true, done)
	repo.MockPublishPost = nil // unused in this path
	repo.MockBulkPublishScheduledPosts = func(_ context.Context) ([]models.Post, error) {
		return []models.Post{{ID: 1, InstagramShare: true}}, nil
	}

	svc := igPostSvc(map[string]string{
		"enable_instagram":       "true",
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid",
		"app_url":                "https://example.com",
	}, repo, ts)

	if _, err := svc.PublishDueScheduledPosts(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	select {
	case status := <-done:
		if status != "published" {
			t.Errorf("expected status 'published', got %q", status)
		}
	case <-time.After(2 * time.Second):
		t.Error("CrossPostToInstagram was not triggered within 2 seconds")
	}
}

func TestPostService_PublishDueScheduledPosts_SkipsOptOut(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Instagram API must not be called for opt-out posts")
	}))
	defer ts.Close()

	repo := &mockRepository{
		MockBulkPublishScheduledPosts: func(_ context.Context) ([]models.Post, error) {
			return []models.Post{{ID: 1, InstagramShare: false}}, nil
		},
		MockUpdatePostInstagramStatus: func(_ context.Context, _ models.UpdatePostInstagramStatusParams) error {
			t.Error("UpdatePostInstagramStatus must not be called for opt-out posts")
			return nil
		},
	}

	svc := igPostSvc(map[string]string{"enable_instagram": "true"}, repo, ts)
	if _, err := svc.PublishDueScheduledPosts(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPostService_PublishDueScheduledPosts_NoDoublePublish(t *testing.T) {
	ts := igMockServer(t)
	defer ts.Close()

	calls := make(chan int64, 10)
	repo := &mockRepository{
		MockBulkPublishScheduledPosts: func(_ context.Context) ([]models.Post, error) {
			return []models.Post{
				{ID: 1, InstagramShare: true},  // should fire
				{ID: 2, InstagramShare: false}, // should be skipped
			}, nil
		},
		MockGetPost: func(_ context.Context, id int64) (models.Post, error) {
			return models.Post{ID: id, InstagramShare: true, Content: "![img](/2026/06/test.jpg)"}, nil
		},
		MockGetMediaByPaths: func(_ context.Context, _ []string) ([]models.Medium, error) {
			return []models.Medium{{OriginalPath: "originals/2026/06/test.jpg"}}, nil
		},
		MockGetTagsForPost: func(_ context.Context, _ int64) ([]models.Tag, error) {
			return nil, nil
		},
		MockUpdatePostInstagramStatus: func(_ context.Context, arg models.UpdatePostInstagramStatusParams) error {
			calls <- arg.ID
			return nil
		},
	}

	svc := igPostSvc(map[string]string{
		"enable_instagram":       "true",
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid",
		"app_url":                "https://example.com",
	}, repo, ts)

	if _, err := svc.PublishDueScheduledPosts(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	select {
	case postID := <-calls:
		if postID != 1 {
			t.Errorf("expected cross-post for post 1, got post %d", postID)
		}
	case <-time.After(2 * time.Second):
		t.Error("no cross-post was triggered within 2 seconds")
	}

	// Verify post 2 (InstagramShare=false) was not cross-posted.
	select {
	case postID := <-calls:
		t.Errorf("unexpected cross-post for post %d (InstagramShare=false should be skipped)", postID)
	case <-time.After(100 * time.Millisecond):
		// correct — no second call
	}
}
