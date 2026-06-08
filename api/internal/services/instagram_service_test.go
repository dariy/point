package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/models"
)

// mockSecrets returns a SettingsService backed by a mockRepository that serves
// the provided key→value map as secrets.
func mockSecrets(secrets map[string]string) *SettingsService {
	repo := &mockRepository{
		MockGetSecret: func(_ context.Context, key string) (models.BlogSecret, error) {
			if val, ok := secrets[key]; ok {
				return models.BlogSecret{Key: key, Value: sql.NullString{String: val, Valid: true}}, nil
			}
			return models.BlogSecret{}, fmt.Errorf("secret not found")
		},
	}
	return NewSettingsService(repo)
}

func newTestInstagram(t *testing.T, secrets map[string]string, handler http.Handler) *InstagramService {
	t.Helper()
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	svc := NewInstagramService(mockSecrets(secrets))
	return svc.withBaseURL(ts.URL)
}

// ── ExchangeCodeForLongLivedToken ─────────────────────────────────────────────

func TestInstagram_ExchangeCodeForLongLivedToken_Success(t *testing.T) {
	callCount := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if r.URL.Path != "/oauth/access_token" {
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		q := r.URL.Query()
		switch callCount {
		case 1:
			// short-lived exchange
			if q.Get("code") != "mycode" || q.Get("redirect_uri") != "https://example.com/callback" {
				http.Error(w, "bad params", http.StatusBadRequest)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "short-token"})
		case 2:
			// long-lived exchange
			if q.Get("grant_type") != "fb_exchange_token" || q.Get("fb_exchange_token") != "short-token" {
				http.Error(w, "bad params", http.StatusBadRequest)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "long-token", "expires_in": 5183944})
		}
	})

	svc := newTestInstagram(t, map[string]string{
		"instagram_app_id":     "app123",
		"instagram_app_secret": "secret456",
	}, handler)

	token, expires, err := svc.ExchangeCodeForLongLivedToken(context.Background(), "mycode", "https://example.com/callback")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "long-token" {
		t.Errorf("token = %q, want %q", token, "long-token")
	}
	if expires != 5183944 {
		t.Errorf("expires_in = %d, want 5183944", expires)
	}
	if callCount != 2 {
		t.Errorf("expected 2 API calls, got %d", callCount)
	}
}

func TestInstagram_ExchangeCodeForLongLivedToken_MissingSecret(t *testing.T) {
	svc := NewInstagramService(mockSecrets(map[string]string{}))
	_, _, err := svc.ExchangeCodeForLongLivedToken(context.Background(), "code", "https://example.com/cb")
	if err == nil || !strings.Contains(err.Error(), "instagram_app_id") {
		t.Errorf("expected missing secret error, got %v", err)
	}
}

func TestInstagram_ExchangeCodeForLongLivedToken_APIError(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "Invalid OAuth access token", "code": 190},
		})
	})
	svc := newTestInstagram(t, map[string]string{
		"instagram_app_id":     "app123",
		"instagram_app_secret": "secret456",
	}, handler)

	_, _, err := svc.ExchangeCodeForLongLivedToken(context.Background(), "bad-code", "https://example.com/cb")
	if err == nil || !strings.Contains(err.Error(), "190") {
		t.Errorf("expected API error, got %v", err)
	}
}

// ── RefreshLongLivedToken ─────────────────────────────────────────────────────

func TestInstagram_RefreshLongLivedToken_Success(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/refresh_access_token" {
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("grant_type") != "ig_refresh_token" {
			http.Error(w, "bad grant_type", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "refreshed-token", "expires_in": 5183000})
	})

	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "old-token"}, handler)

	token, expires, err := svc.RefreshLongLivedToken(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "refreshed-token" {
		t.Errorf("token = %q, want %q", token, "refreshed-token")
	}
	if expires != 5183000 {
		t.Errorf("expires_in = %d, want 5183000", expires)
	}
}

func TestInstagram_RefreshLongLivedToken_MissingSecret(t *testing.T) {
	svc := NewInstagramService(mockSecrets(map[string]string{}))
	_, _, err := svc.RefreshLongLivedToken(context.Background())
	if err == nil || !strings.Contains(err.Error(), "instagram_access_token") {
		t.Errorf("expected missing secret error, got %v", err)
	}
}

func TestInstagram_RefreshLongLivedToken_APIError(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "Token expired", "code": 463},
		})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "expired"}, handler)

	_, _, err := svc.RefreshLongLivedToken(context.Background())
	if err == nil || !strings.Contains(err.Error(), "463") {
		t.Errorf("expected API error, got %v", err)
	}
}

// ── GetConnectedAccount ───────────────────────────────────────────────────────

func TestInstagram_GetConnectedAccount_Success(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/me" {
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "ig-user-999", "username": "testuser"})
	})

	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "tok"}, handler)

	username, igUserID, err := svc.GetConnectedAccount(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if username != "testuser" {
		t.Errorf("username = %q, want %q", username, "testuser")
	}
	if igUserID != "ig-user-999" {
		t.Errorf("igUserID = %q, want %q", igUserID, "ig-user-999")
	}
}

func TestInstagram_GetConnectedAccount_APIError(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "Invalid token", "code": 190},
		})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "bad"}, handler)

	_, _, err := svc.GetConnectedAccount(context.Background())
	if err == nil {
		t.Error("expected error")
	}
}

// ── CreateImageContainer ──────────────────────────────────────────────────────

func TestInstagram_CreateImageContainer_Success(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "want POST", http.StatusMethodNotAllowed)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/media") {
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		r.ParseForm()
		if r.FormValue("is_carousel_item") != "" {
			http.Error(w, "should not be carousel item", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "container-111"})
	})

	svc := newTestInstagram(t, map[string]string{
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid123",
	}, handler)

	id, err := svc.CreateImageContainer(context.Background(), "https://example.com/img.jpg", "My caption")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "container-111" {
		t.Errorf("id = %q, want %q", id, "container-111")
	}
}

func TestInstagram_CreateImageContainer_APIError(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "Insufficient permissions", "code": 200},
		})
	})
	svc := newTestInstagram(t, map[string]string{
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid123",
	}, handler)

	_, err := svc.CreateImageContainer(context.Background(), "https://example.com/img.jpg", "caption")
	if err == nil || !strings.Contains(err.Error(), "200") {
		t.Errorf("expected API error, got %v", err)
	}
}

// ── CreateCarouselChild ───────────────────────────────────────────────────────

func TestInstagram_CreateCarouselChild_Success(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.FormValue("is_carousel_item") != "true" {
			http.Error(w, "expected is_carousel_item=true", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "child-222"})
	})

	svc := newTestInstagram(t, map[string]string{
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid123",
	}, handler)

	id, err := svc.CreateCarouselChild(context.Background(), "https://example.com/img2.jpg")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "child-222" {
		t.Errorf("id = %q, want %q", id, "child-222")
	}
}

func TestInstagram_CreateCarouselChild_MissingSecret(t *testing.T) {
	svc := NewInstagramService(mockSecrets(map[string]string{}))
	_, err := svc.CreateCarouselChild(context.Background(), "https://example.com/img.jpg")
	if err == nil {
		t.Error("expected error for missing secret")
	}
}

// ── CreateCarousel ────────────────────────────────────────────────────────────

func TestInstagram_CreateCarousel_Success(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.FormValue("media_type") != "CAROUSEL" {
			http.Error(w, "expected media_type=CAROUSEL", http.StatusBadRequest)
			return
		}
		children := r.FormValue("children")
		if children != "child-1,child-2,child-3" {
			http.Error(w, "unexpected children: "+children, http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "carousel-333"})
	})

	svc := newTestInstagram(t, map[string]string{
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid123",
	}, handler)

	id, err := svc.CreateCarousel(context.Background(), []string{"child-1", "child-2", "child-3"}, "carousel caption")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "carousel-333" {
		t.Errorf("id = %q, want %q", id, "carousel-333")
	}
}

// ── PublishContainer ──────────────────────────────────────────────────────────

func TestInstagram_PublishContainer_Success(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "want POST", http.StatusMethodNotAllowed)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/media_publish") {
			http.Error(w, "unexpected path: "+r.URL.Path, http.StatusBadRequest)
			return
		}
		r.ParseForm()
		if r.FormValue("creation_id") != "container-444" {
			http.Error(w, "bad creation_id", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "published-555"})
	})

	svc := newTestInstagram(t, map[string]string{
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid123",
	}, handler)

	mediaID, err := svc.PublishContainer(context.Background(), "container-444")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mediaID != "published-555" {
		t.Errorf("mediaID = %q, want %q", mediaID, "published-555")
	}
}

func TestInstagram_PublishContainer_APIError(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "Container not ready", "code": 9007},
		})
	})
	svc := newTestInstagram(t, map[string]string{
		"instagram_access_token": "tok",
		"instagram_user_id":      "uid123",
	}, handler)

	_, err := svc.PublishContainer(context.Background(), "not-ready")
	if err == nil || !strings.Contains(err.Error(), "9007") {
		t.Errorf("expected API error with code, got %v", err)
	}
}
