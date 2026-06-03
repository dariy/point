package services

import (
	"context"
	"os"
	"testing"

	"point-api/internal/config"
	"point-api/internal/repository"
)

func setupTestDB(t *testing.T) repository.Repository {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	return repo
}

func setupPostService(t *testing.T) (*PostService, repository.Repository) {
	repo := setupTestDB(t)
	service := NewPostService(repo)
	return service, repo
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

func setupAuthService(t *testing.T) (*AuthService, repository.Repository) {
	repo := setupTestDB(t)
	return NewAuthService(repo), repo
}

func setupTagService(t *testing.T) (*TagService, repository.Repository) {
	repo := setupTestDB(t)
	service := NewTagService(repo)
	return service, repo
}

func setupCacheService(t *testing.T) (*CacheService, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "cache-test")
	if err != nil {
		t.Fatal(err)
	}
	svc := NewCacheService(dir)
	return svc, dir
}

func setupTimelineService(t *testing.T) (*TimelineService, *TagService, *PostService, int64) {
	repo := setupTestDB(t)
	// Ensure system tags exist so _in_timeline is available
	if err := repo.EnsureSystemTags(context.Background()); err != nil {
		t.Fatalf("failed to ensure system tags: %v", err)
	}
	// Create a user for posts
	res, err := repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('test', 'test@test.com', 'hash', 'Test User')`)
	if err != nil {
		t.Fatalf("failed to create test user: %v", err)
	}
	userID, _ := res.LastInsertId()

	timelineService := NewTimelineService(repo)
	tagService := NewTagService(repo)
	postService := NewPostService(repo)
	return timelineService, tagService, postService, userID
}

func setupSystemService(t *testing.T) (*SystemService, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "system-test")
	if err != nil {
		t.Fatal(err)
	}
	repo := setupTestDB(t)
	t.Cleanup(func() {
		_ = repo.Close()
		_ = os.RemoveAll(dir)
	})
	return NewSystemService(repo, dir), dir
}

func insertTestUser(t *testing.T, svc *PostService) int64 {
	t.Helper()
	res, err := svc.repo.DB().Exec(
		`INSERT OR IGNORE INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`,
	)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	_ = res
	return 1
}
