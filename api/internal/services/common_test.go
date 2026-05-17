package services

import (
	"os"
	"testing"

	"point-api/internal/config"
	"point-api/internal/repository"
)

func setupTestDB(t *testing.T) *repository.Repository {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	return repo
}

func setupMediaService(t *testing.T) (*MediaService, string) {
	repo := setupTestDB(t)
	tmpDir, err := os.MkdirTemp("", "media-test")
	if err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		StoragePath:     tmpDir,
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}
	settingsService := NewSettingsService(repo)
	tagService := NewTagService(repo)
	service := NewMediaService(repo, cfg, settingsService, tagService)

	return service, tmpDir
}

func setupTagService(t *testing.T) (*TagService, *repository.Repository) {
	repo := setupTestDB(t)
	service := NewTagService(repo)
	return service, repo
}

func setupPostService(t *testing.T) (*PostService, *repository.Repository) {
	repo := setupTestDB(t)
	service := NewPostService(repo)
	return service, repo
}

