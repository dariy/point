package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// guardEnv builds a real, migrated database in a temp data directory, plus the
// service and config the boot path would hand runMigrationsGuarded.
func guardEnv(t *testing.T) (repository.Repository, *services.SystemService, config.Config, string) {
	t.Helper()
	dataPath := t.TempDir()
	dbPath := filepath.Join(dataPath, "point.db")

	repo, err := repository.NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	cfg := config.Config{
		StoragePath:         dataPath,
		DatabaseURL:         dbPath,
		MigrationBackup:     true,
		MigrationBackupKeep: 3,
	}
	return repo, services.NewSystemService(repo, dataPath, dbPath), cfg, dataPath
}

func snapshotsIn(t *testing.T, dataPath string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dataPath, "backups", "migrations"))
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "premigration_") {
			names = append(names, e.Name())
		}
	}
	return names
}

// newestFile returns the most recently written of names, resolved in dir.
func newestFile(t *testing.T, dir string, names []string) string {
	t.Helper()
	var newest string
	var when time.Time
	for _, n := range names {
		info, err := os.Stat(filepath.Join(dir, n))
		if err != nil {
			t.Fatal(err)
		}
		if info.ModTime().After(when) || newest == "" {
			newest, when = filepath.Join(dir, n), info.ModTime()
		}
	}
	return newest
}

func TestRunMigrationsGuarded_CleanRunTakesOneSnapshot(t *testing.T) {
	repo, sys, cfg, dataPath := guardEnv(t)
	ctx := context.Background()

	// A database built from schema.sql has every step outstanding, so this boot
	// has work to do and is worth protecting.
	restored, err := runMigrationsGuarded(ctx, repo, sys, cfg)
	if err != nil {
		t.Fatalf("runMigrationsGuarded: %v", err)
	}
	if restored {
		t.Error("reported a restore after a successful migration")
	}
	if got := snapshotsIn(t, dataPath); len(got) != 1 {
		t.Errorf("took %d snapshots (%v), want exactly 1", len(got), got)
	}

	// Second call: nothing pending, so nothing to snapshot.
	if _, err := runMigrationsGuarded(ctx, repo, sys, cfg); err != nil {
		t.Fatalf("second runMigrationsGuarded: %v", err)
	}
	if got := snapshotsIn(t, dataPath); len(got) != 1 {
		t.Errorf("a boot with nothing pending took a snapshot: %v", got)
	}
}

func TestRunMigrationsGuarded_DisabledByConfig(t *testing.T) {
	repo, sys, cfg, dataPath := guardEnv(t)
	cfg.MigrationBackup = false

	if _, err := runMigrationsGuarded(context.Background(), repo, sys, cfg); err != nil {
		t.Fatalf("runMigrationsGuarded: %v", err)
	}
	if got := snapshotsIn(t, dataPath); len(got) != 0 {
		t.Errorf("MIGRATION_BACKUP=false still took snapshots: %v", got)
	}
	// The migrations themselves must still have run.
	var count int
	if err := repo.DB().QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM migration_history`).Scan(&count); err != nil {
		t.Fatalf("count history: %v", err)
	}
	if count == 0 {
		t.Error("no migrations were applied with the snapshot disabled")
	}
}

func TestRunMigrationsGuarded_RestoresOnFailure(t *testing.T) {
	repo, sys, cfg, dataPath := guardEnv(t)
	ctx := context.Background()

	if _, err := runMigrationsGuarded(ctx, repo, sys, cfg); err != nil {
		t.Fatalf("initial migration: %v", err)
	}

	// Force the next pass to run every step against a schema that cannot
	// satisfy them.
	for _, stmt := range []string{`DELETE FROM migration_history`, `DROP TABLE tags`} {
		if _, err := repo.DB().ExecContext(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}

	restored, err := runMigrationsGuarded(ctx, repo, sys, cfg)
	if err == nil {
		t.Fatal("runMigrationsGuarded returned nil against a broken schema")
	}
	if !restored {
		t.Fatalf("the database was not restored after a failed migration: %v", err)
	}

	// The database on disk is the snapshot this call took, byte for byte, and
	// the pool was closed before the swap.
	snaps := snapshotsIn(t, dataPath)
	if len(snaps) != 2 {
		t.Fatalf("expected the failing boot to add a second snapshot, got %v", snaps)
	}
	newest := newestFile(t, filepath.Join(dataPath, "backups", "migrations"), snaps)
	onDisk, err := os.ReadFile(cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("read database: %v", err)
	}
	fromSnapshot, err := os.ReadFile(newest)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if !bytes.Equal(onDisk, fromSnapshot) {
		t.Error("the database on disk is not the snapshot that was restored")
	}
}
