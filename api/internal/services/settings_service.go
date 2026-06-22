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

type SettingsService struct {
	repo  repository.Repository
	mu    sync.RWMutex
	cache map[string]string
}

func NewSettingsService(repo repository.Repository) *SettingsService {
	return &SettingsService{repo: repo}
}

func (s *SettingsService) GetSetting(ctx context.Context, key string, defaultValue string) (string, error) {
	s.mu.RLock()
	if s.cache != nil {
		if val, ok := s.cache[key]; ok {
			s.mu.RUnlock()
			return val, nil
		}
		s.mu.RUnlock()
		return defaultValue, nil
	}
	s.mu.RUnlock()

	setting, err := s.repo.GetSetting(ctx, key)
	if err != nil {
		return defaultValue, nil
	}
	if !setting.Value.Valid {
		return defaultValue, nil
	}
	return setting.Value.String, nil
}

func (s *SettingsService) SetSetting(ctx context.Context, key string, value string, valueType string) error {
	_, err := s.repo.UpdateSetting(ctx, models.UpdateSettingParams{
		Key:       key,
		Value:     sql.NullString{String: value, Valid: true},
		ValueType: valueType,
	})
	if err == nil {
		s.mu.Lock()
		if s.cache != nil {
			s.cache[key] = value
		}
		s.mu.Unlock()
	}
	return err
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

func (s *SettingsService) GetAllSettings(ctx context.Context) (map[string]string, error) {
	s.mu.RLock()
	if s.cache != nil {
		res := make(map[string]string, len(s.cache))
		for k, v := range s.cache {
			res[k] = v
		}
		s.mu.RUnlock()
		return res, nil
	}
	s.mu.RUnlock()

	settings, err := s.repo.ListSettings(ctx)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache = make(map[string]string)
	for _, setting := range settings {
		if setting.Value.Valid {
			s.cache[setting.Key] = setting.Value.String
		}
	}

	res := make(map[string]string, len(s.cache))
	for k, v := range s.cache {
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
