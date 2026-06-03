package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"strconv"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
)

type SettingsService struct {
	repo repository.Repository
}

func NewSettingsService(repo repository.Repository) *SettingsService {
	return &SettingsService{repo: repo}
}

func (s *SettingsService) GetSetting(ctx context.Context, key string, defaultValue string) (string, error) {
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
	settings, err := s.repo.ListSettings(ctx)
	if err != nil {
		return nil, err
	}
	result := make(map[string]string)
	for _, s := range settings {
		if s.Value.Valid {
			result[s.Key] = s.Value.String
		}
	}
	return result, nil
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
		log.Printf("loaded secret key from database secrets")
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
	log.Printf("generated and stored new secret key in database secrets")
	return nil
}
