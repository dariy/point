package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strconv"
	"sync"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
)

// SettingsService caches the whole settings table in process. Settings are read
// several times per request — the RequirePlugin middleware, the per-request
// plugin manifest, and handlers all consult them — while writes only happen when
// an admin saves a form, so a read-through cache is heavily one-sided.
//
// The cached map is immutable once published: writes clone it, mutate the clone
// and swap the pointer under the write lock. That is what makes Snapshot able to
// hand the map straight to readers with no copy and no race. This process is the
// only writer of the settings table; out-of-band changes (a restore, the setup
// CLI) only take effect at the next boot, which is when the cache is cold anyway.
type SettingsService struct {
	repo  repository.Repository
	mu    sync.RWMutex
	cache map[string]string // nil = cold; never mutated in place once non-nil
}

func NewSettingsService(repo repository.Repository) *SettingsService {
	return &SettingsService{repo: repo}
}

// load returns the cached settings map, reading the table once if the cache is
// cold. The returned map must be treated as read-only by callers.
func (s *SettingsService) load(ctx context.Context) (map[string]string, error) {
	s.mu.RLock()
	cached := s.cache
	s.mu.RUnlock()
	if cached != nil {
		return cached, nil
	}

	settings, err := s.repo.ListSettings(ctx)
	if err != nil {
		return nil, err
	}
	fresh := make(map[string]string, len(settings))
	for _, setting := range settings {
		if setting.Value.Valid {
			fresh[setting.Key] = setting.Value.String
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// Another goroutine may have populated the cache while we were querying;
	// keep whichever map won so callers never see the cache flip back and forth.
	if s.cache == nil {
		s.cache = fresh
	}
	return s.cache, nil
}

// InvalidateCache drops the cached settings so the next read re-queries the
// table. Needed by anything that writes settings without going through
// SetSetting — and by tests that mutate the table directly.
func (s *SettingsService) InvalidateCache() {
	s.mu.Lock()
	s.cache = nil
	s.mu.Unlock()
}

// Snapshot returns the settings map WITHOUT copying it. The map is shared with
// the cache and with every other caller, so it must only ever be read. Callers
// that need to add or change keys (e.g. the admin API decorating the response
// with "<key>_is_set" flags) must use GetAllSettings instead.
func (s *SettingsService) Snapshot(ctx context.Context) (map[string]string, error) {
	return s.load(ctx)
}

func (s *SettingsService) GetSetting(ctx context.Context, key string, defaultValue string) (string, error) {
	all, err := s.load(ctx)
	if err != nil {
		// Cache load failed — fall back to the single-key read so one bad
		// ListSettings does not take down every settings-dependent code path.
		setting, err := s.repo.GetSetting(ctx, key)
		if err != nil || !setting.Value.Valid {
			return defaultValue, nil
		}
		return setting.Value.String, nil
	}
	if val, ok := all[key]; ok {
		return val, nil
	}
	return defaultValue, nil
}

func (s *SettingsService) SetSetting(ctx context.Context, key string, value string, valueType string) error {
	_, err := s.repo.UpdateSetting(ctx, models.UpdateSettingParams{
		Key:       key,
		Value:     sql.NullString{String: value, Valid: true},
		ValueType: valueType,
	})
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cache != nil {
		// Copy-on-write: readers hold the old map and must not see it change.
		next := make(map[string]string, len(s.cache)+1)
		for k, v := range s.cache {
			next[k] = v
		}
		next[key] = value
		s.cache = next
	}
	s.mu.Unlock()
	return nil
}

// GetConfigSetting resolves a runtime-tunable integer config value using a
// three-tier priority: env var > DB setting > hard-coded default.
// envValue is the value loaded from the config struct (0 means "not set").
func (s *SettingsService) GetConfigSetting(ctx context.Context, key string, envValue int, defaultValue int) int {
	if envValue != 0 {
		return envValue
	}
	raw, _ := s.GetSetting(ctx, key, "")
	if raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v != 0 {
			return v
		}
	}
	return defaultValue
}

// GetAllSettings returns a private copy of the settings the caller is free to
// mutate. Read-only callers on hot paths should prefer Snapshot, which skips
// the copy.
func (s *SettingsService) GetAllSettings(ctx context.Context) (map[string]string, error) {
	all, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	res := make(map[string]string, len(all))
	for k, v := range all {
		res[k] = v
	}
	return res, nil
}

func (s *SettingsService) GetSecret(ctx context.Context, key string) (string, error) {
	row, err := s.repo.GetSecret(ctx, key)
	if err != nil {
		return "", err
	}
	if !row.Value.Valid {
		return "", nil
	}
	return row.Value.String, nil
}

func (s *SettingsService) SetSecret(ctx context.Context, key, value string) error {
	return s.repo.UpsertSecret(ctx, models.UpsertSecretParams{
		Key:   key,
		Value: sql.NullString{String: value, Valid: true},
	})
}

func (s *SettingsService) DeleteSecret(ctx context.Context, key string) error {
	return s.repo.DeleteSecret(ctx, key)
}

func (s *SettingsService) SecretIsSet(ctx context.Context, key string) bool {
	val, err := s.GetSecret(ctx, key)
	return err == nil && val != ""
}

func (s *SettingsService) EnsureSecretKey(ctx context.Context, cfg *config.Config) error {
	if cfg.SecretKey != "" {
		return nil
	}
	existing, err := s.GetSecret(ctx, "_secret_key")
	if err == nil && existing != "" {
		cfg.SecretKey = existing
		slog.Info("loaded secret key from database secrets")
		return nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Errorf("generate secret key: %w", err)
	}
	key := hex.EncodeToString(raw)
	if err := s.SetSecret(ctx, "_secret_key", key); err != nil {
		return fmt.Errorf("store secret key: %w", err)
	}
	cfg.SecretKey = key
	slog.Info("generated and stored new secret key in database secrets")
	return nil
}
