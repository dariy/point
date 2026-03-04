package services

import (
	"context"
	"database/sql"
	"point-api/internal/models"
	"point-api/internal/repository"
)

type SettingsService struct {
	repo *repository.Repository
}

func NewSettingsService(repo *repository.Repository) *SettingsService {
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
