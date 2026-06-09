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
		switch r.URL.Path {
		case "/oauth/access_token":
			if r.Method == http.MethodPost {
				// step 1: code → short-lived token
				if err := r.ParseForm(); err != nil {
					http.Error(w, "parse error", http.StatusBadRequest)
					return
				}
				if r.FormValue("code") != "mycode" || r.FormValue("redirect_uri") != "https://example.com/callback" {
					http.Error(w, "bad params", http.StatusBadRequest)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "short-token", "user_id": 987654321})
			} else {
				// step 2: short-lived → long-lived (GET, fb_exchange_token grant)
				q := r.URL.Query()
				if q.Get("grant_type") != "fb_exchange_token" || q.Get("fb_exchange_token") != "short-token" || q.Get("client_id") != "app123" {
					http.Error(w, "bad params", http.StatusBadRequest)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "long-token", "expires_in": 5183944})
			}
		default:
			http.Error(w, "unexpected path: "+r.URL.Path, http.StatusBadRequest)
		}
	})

	svc := newTestInstagram(t, map[string]string{
		"instagram_app_id":     "app123",
		"instagram_app_secret": "secret456",
	}, handler)

	token, userID, expires, err := svc.ExchangeCodeForLongLivedToken(context.Background(), "mycode", "https://example.com/callback")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "long-token" {
		t.Errorf("token = %q, want %q", token, "long-token")
	}
	if userID != "987654321" {
		t.Errorf("userID = %q, want %q", userID, "987654321")
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
	_, _, _, err := svc.ExchangeCodeForLongLivedToken(context.Background(), "code", "https://example.com/cb")
	if err == nil || !strings.Contains(err.Error(), "instagram_app_id") {
		t.Errorf("expected missing secret error, got %v", err)
	}
}

func TestInstagram_ExchangeCodeForLongLivedToken_APIError(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "Invalid OAuth access token", "code": 190},
		})
	})
	svc := newTestInstagram(t, map[string]string{
		"instagram_app_id":     "app123",
		"instagram_app_secret": "secret456",
	}, handler)

	_, _, _, err := svc.ExchangeCodeForLongLivedToken(context.Background(), "bad-code", "https://example.com/cb")
	if err == nil || !strings.Contains(err.Error(), "190") {
		t.Errorf("expected API error, got %v", err)
	}
}

// ── ExchangeShortLivedForLongLived ────────────────────────────────────────────

func TestInstagram_ExchangeShortLivedForLongLived_Success(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/access_token" || r.Method != http.MethodGet {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		q := r.URL.Query()
		if q.Get("grant_type") != "fb_exchange_token" ||
			q.Get("fb_exchange_token") != "short-tok" ||
			q.Get("client_id") != "app123" ||
			q.Get("client_secret") != "secret456" {
			http.Error(w, "bad params", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "long-tok", "expires_in": 5183944})
	})

	svc := newTestInstagram(t, map[string]string{
		"instagram_app_id":     "app123",
		"instagram_app_secret": "secret456",
	}, handler)

	token, expires, err := svc.ExchangeShortLivedForLongLived(context.Background(), "short-tok")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "long-tok" {
		t.Errorf("token = %q, want %q", token, "long-tok")
	}
	if expires != 5183944 {
		t.Errorf("expires_in = %d, want 5183944", expires)
	}
}

func TestInstagram_ExchangeShortLivedForLongLived_MissingSecret(t *testing.T) {
	svc := NewInstagramService(mockSecrets(map[string]string{}))
	_, _, err := svc.ExchangeShortLivedForLongLived(context.Background(), "tok")
	if err == nil || !strings.Contains(err.Error(), "instagram_app_id") {
		t.Errorf("expected missing secret error, got %v", err)
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
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "refreshed-token", "expires_in": 5183000})
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
		_ = json.NewEncoder(w).Encode(map[string]any{
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
		_ = json.NewEncoder(w).Encode(map[string]any{"user_id": "999", "username": "testuser", "account_type": "BUSINESS"})
	})

	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "tok"}, handler)

	username, igUserID, accountType, err := svc.GetConnectedAccount(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if username != "testuser" {
		t.Errorf("username = %q, want %q", username, "testuser")
	}
	if igUserID != "999" {
		t.Errorf("igUserID = %q, want %q", igUserID, "999")
	}
	if accountType != "BUSINESS" {
		t.Errorf("accountType = %q, want %q", accountType, "BUSINESS")
	}
}

func TestInstagram_GetConnectedAccount_APIError(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "Invalid token", "code": 190},
		})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "bad"}, handler)

	_, _, _, err := svc.GetConnectedAccount(context.Background())
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
		_ = r.ParseForm()
		if r.FormValue("is_carousel_item") != "" {
			http.Error(w, "should not be carousel item", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "container-111"})
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
		_ = json.NewEncoder(w).Encode(map[string]any{
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
		_ = r.ParseForm()
		if r.FormValue("is_carousel_item") != "true" {
			http.Error(w, "expected is_carousel_item=true", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "child-222"})
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
		_ = r.ParseForm()
		if r.FormValue("media_type") != "CAROUSEL" {
			http.Error(w, "expected media_type=CAROUSEL", http.StatusBadRequest)
			return
		}
		children := r.FormValue("children")
		if children != "child-1,child-2,child-3" {
			http.Error(w, "unexpected children: "+children, http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "carousel-333"})
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
		_ = r.ParseForm()
		if r.FormValue("creation_id") != "container-444" {
			http.Error(w, "bad creation_id", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "published-555"})
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
		_ = json.NewEncoder(w).Encode(map[string]any{
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

// ── WaitForContainerReady ─────────────────────────────────────────────────────

func TestInstagram_WaitForContainerReady_FINISHED(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("fields") == "" {
			http.Error(w, "missing fields param", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status_code": "FINISHED"})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "tok"}, handler)

	if err := svc.WaitForContainerReady(context.Background(), "container-abc"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestInstagram_WaitForContainerReady_MultiPollThenFinished(t *testing.T) {
	calls := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			_ = json.NewEncoder(w).Encode(map[string]any{"status_code": "IN_PROGRESS"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status_code": "FINISHED"})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "tok"}, handler)

	if err := svc.WaitForContainerReady(context.Background(), "container-abc"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 3 {
		t.Errorf("expected 3 polls, got %d", calls)
	}
}

func TestInstagram_WaitForContainerReady_ERROR(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status_code": "ERROR", "status": "media upload failed"})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "tok"}, handler)

	err := svc.WaitForContainerReady(context.Background(), "container-abc")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "ERROR") {
		t.Errorf("error should mention ERROR status, got: %v", err)
	}
	if !strings.Contains(err.Error(), "media upload failed") {
		t.Errorf("error should include status text, got: %v", err)
	}
}

func TestInstagram_WaitForContainerReady_EXPIRED(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status_code": "EXPIRED", "status": ""})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "tok"}, handler)

	err := svc.WaitForContainerReady(context.Background(), "container-abc")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "EXPIRED") {
		t.Errorf("error should mention EXPIRED, got: %v", err)
	}
}

func TestInstagram_WaitForContainerReady_MissingSecret(t *testing.T) {
	svc := NewInstagramService(mockSecrets(map[string]string{}))
	err := svc.WaitForContainerReady(context.Background(), "container-abc")
	if err == nil || !strings.Contains(err.Error(), "instagram_access_token") {
		t.Errorf("expected missing secret error, got %v", err)
	}
}

// ── Error Parsing ────────────────────────────────────────────────────────────

func TestInstagram_APIErrorParsing_WithUserMsg(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message":        "Original meta message",
				"code":           100,
				"error_subcode":  33,
				"error_user_msg": "Friendly user message",
				"fbtrace_id":     "ABC123XYZ",
			},
		})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "bad"}, handler)

	_, _, _, err := svc.GetConnectedAccount(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	expected := "get connected account: instagram API error 100 (subcode 33, fbtrace ABC123XYZ): Friendly user message"
	if err.Error() != expected {
		t.Errorf("error = %q, want %q", err.Error(), expected)
	}
}

func TestInstagram_APIErrorParsing_WithoutUserMsg(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"message":       "Original meta message",
				"code":          100,
				"error_subcode": 33,
				"fbtrace_id":    "ABC123XYZ",
			},
		})
	})
	svc := newTestInstagram(t, map[string]string{"instagram_access_token": "bad"}, handler)

	_, _, _, err := svc.GetConnectedAccount(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	expected := "get connected account: instagram API error 100 (subcode 33, fbtrace ABC123XYZ): Original meta message"
	if err.Error() != expected {
		t.Errorf("error = %q, want %q", err.Error(), expected)
	}
}
