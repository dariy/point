//go:build integration

package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"point-api/internal/config"
	"point-api/internal/repository"
)

func TestSystemService_NewSystemService(t *testing.T) {
	svc, _ := setupSystemService(t)
	if svc == nil {
		t.Error("expected non-nil SystemService")
	}
}

func TestSystemService_GetDiskInfo(t *testing.T) {
	svc, _ := setupSystemService(t)
	info, err := svc.GetDiskInfo()
	if err != nil {
		t.Fatalf("GetDiskInfo failed: %v", err)
	}
	if info.Total <= 0 {
		t.Errorf("expected Total > 0, got %d", info.Total)
	}
	if info.Free < 0 {
		t.Errorf("expected Free >= 0, got %d", info.Free)
	}
	if info.Used != info.Total-info.Free {
		t.Errorf("used mismatch: Total=%d Free=%d Used=%d", info.Total, info.Free, info.Used)
	}
}

func TestSystemService_CreateBackup(t *testing.T) {
	svc, dir := setupSystemService(t)

	// Create a small file in the data dir so the tar has something to archive
	_ = os.WriteFile(filepath.Join(dir, "test.txt"), []byte("data"), 0644)

	name, size, err := svc.CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup failed: %v", err)
	}
	if name == "" {
		t.Error("expected non-empty backup name")
	}
	if size <= 0 {
		t.Errorf("expected size > 0, got %d", size)
	}

	// Verify the backup file exists
	backupPath := filepath.Join(dir, "backups", name)
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		t.Errorf("backup file not found at %s", backupPath)
	}
}

func TestSystemService_RestoreBackup_InvalidFilename(t *testing.T) {
	svc, _ := setupSystemService(t)

	// Empty filename
	if err := svc.RestoreBackup(context.Background(), ""); err == nil {
		t.Error("expected error for empty filename")
	}

	// Path traversal
	if err := svc.RestoreBackup(context.Background(), "../etc/passwd"); err == nil {
		t.Error("expected error for path traversal filename")
	}

	// Non-existent backup
	if err := svc.RestoreBackup(context.Background(), "no_such_backup.tar.gz"); err == nil {
		t.Error("expected error for non-existent backup")
	}
}

func TestSchedulerService_New(t *testing.T) {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()

	dir, _ := os.MkdirTemp("", "sched-test")
	defer func() { _ = os.RemoveAll(dir) }()

	cfg := &config.Config{StoragePath: dir}
	settingsSvc := NewSettingsService(repo)
	tagSvc := NewTagService(repo)
	authSvc := NewAuthService(repo)
	postSvc := NewPostService(repo, nil, nil, nil, "")
	mediaSvc := NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := NewSystemService(repo, dir, "")

	sched := NewSchedulerService(authSvc, postSvc, systemSvc, mediaSvc, settingsSvc, nil)
	if sched == nil {
		t.Error("expected non-nil SchedulerService")
	}

	// Start with a cancelled context so goroutines exit immediately
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	sched.Start(ctx)
}
