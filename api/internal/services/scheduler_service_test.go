package services

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"point-api/internal/models"
)

// settingsStore is a thread-safe in-memory secret store for testing.
type settingsStore struct {
	mu      sync.Mutex
	secrets map[string]string
}

func newSettingsStore(initial map[string]string) *settingsStore {
	s := &settingsStore{secrets: make(map[string]string)}
	for k, v := range initial {
		s.secrets[k] = v
	}
	return s
}

func (s *settingsStore) service() *SettingsService {
	repo := &mockRepository{
		MockGetSecret: func(_ context.Context, key string) (models.BlogSecret, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if val, ok := s.secrets[key]; ok {
				return models.BlogSecret{Key: key, Value: sql.NullString{String: val, Valid: true}}, nil
			}
			return models.BlogSecret{}, nil
		},
		MockUpsertSecret: func(_ context.Context, arg models.UpsertSecretParams) error {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.secrets[arg.Key] = arg.Value.String
			return nil
		},
	}
	return NewSettingsService(repo)
}

func newTestScheduler(store *settingsStore, igHandler http.Handler) *SchedulerService {
	settingsSvc := store.service()
	ts := httptest.NewServer(igHandler)
	igSvc := NewInstagramService(settingsSvc)
	igSvc = igSvc.withBaseURL(ts.URL)
	return &SchedulerService{
		settingsService:  settingsSvc,
		instagramService: igSvc,
	}
}

func TestScheduler_settingInt(t *testing.T) {
	repo := &mockRepository{
		MockGetSetting: func(_ context.Context, key string) (models.BlogSetting, error) {
			vals := map[string]string{"good": "5", "bad": "notanumber"}
			if v, ok := vals[key]; ok {
				return models.BlogSetting{Key: key, Value: sql.NullString{String: v, Valid: true}}, nil
			}
			return models.BlogSetting{}, nil // unset → empty value
		},
	}
	s := &SchedulerService{settingsService: NewSettingsService(repo)}
	ctx := context.Background()

	if got := s.settingInt(ctx, "good", 7); got != 5 {
		t.Errorf("valid setting: got %d, want 5", got)
	}
	if got := s.settingInt(ctx, "bad", 7); got != 7 {
		t.Errorf("unparseable setting: got %d, want default 7", got)
	}
	if got := s.settingInt(ctx, "missing", 7); got != 7 {
		t.Errorf("unset setting: got %d, want default 7", got)
	}
}

func TestScheduler_RefreshInstagramToken_NotConnected(t *testing.T) {
	store := newSettingsStore(map[string]string{}) // no token_expires_at
	sched := newTestScheduler(store, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("API should not be called when not connected")
	}))

	if err := sched.refreshInstagramTokenIfNeeded(context.Background()); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
}

func TestScheduler_RefreshInstagramToken_FarFromExpiry(t *testing.T) {
	expiresAt := time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	store := newSettingsStore(map[string]string{
		"instagram_access_token":    "old-token",
		"instagram_token_expires_at": expiresAt,
	})
	sched := newTestScheduler(store, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("API should not be called when token is far from expiry")
	}))

	if err := sched.refreshInstagramTokenIfNeeded(context.Background()); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if store.secrets["instagram_access_token"] != "old-token" {
		t.Error("token should not have changed")
	}
}

func TestScheduler_RefreshInstagramToken_WithinWindow(t *testing.T) {
	expiresAt := time.Now().Add(3 * 24 * time.Hour).UTC().Format(time.RFC3339) // 3 days — within 7-day window
	store := newSettingsStore(map[string]string{
		"instagram_access_token":    "old-token",
		"instagram_token_expires_at": expiresAt,
	})

	called := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.Path != "/refresh_access_token" {
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new-token","expires_in":5184000}`))
	})

	sched := newTestScheduler(store, handler)
	if err := sched.refreshInstagramTokenIfNeeded(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("expected refresh API to be called")
	}
	if store.secrets["instagram_access_token"] != "new-token" {
		t.Errorf("token = %q, want %q", store.secrets["instagram_access_token"], "new-token")
	}
	if store.secrets["instagram_token_expires_at"] == "" {
		t.Error("token_expires_at should be updated")
	}
}

func TestScheduler_RefreshInstagramToken_ExactlyAtWindow(t *testing.T) {
	// Token expires in exactly 7 days — should trigger refresh (≤ window)
	expiresAt := time.Now().Add(igTokenRefreshWindow).UTC().Format(time.RFC3339)
	store := newSettingsStore(map[string]string{
		"instagram_access_token":    "token",
		"instagram_token_expires_at": expiresAt,
	})

	called := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"refreshed","expires_in":5184000}`))
	})

	sched := newTestScheduler(store, handler)
	if err := sched.refreshInstagramTokenIfNeeded(context.Background()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("expected refresh to be called at exactly the window boundary")
	}
}
