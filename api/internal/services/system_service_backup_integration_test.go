//go:build integration

package services

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/repository"
)

// TestCreateBackup_ConsistentDBSnapshot verifies the archive contains a clean
// VACUUM INTO snapshot of point.db (passes integrity_check, keeps the data) and
// excludes the live -wal/-shm sidecars.
func TestCreateBackup_ConsistentDBSnapshot(t *testing.T) {
	dataPath := t.TempDir()
	dbPath := filepath.Join(dataPath, "point.db")

	repo, err := repository.NewRepository(dbPath)
	if err != nil {
		t.Fatalf("open repo: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	// A write forces WAL sidecars (point.db-wal/-shm) to exist on disk.
	if _, err := repo.DB().Exec(
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('mover','m@x.com','h','Mover')`,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	s := NewSystemService(repo, dataPath, dbPath)
	name, _, err := s.CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	archivePath := filepath.Join(dataPath, "backups", name)

	// A checksum sidecar is written and matches the archive bytes.
	sidecar, err := os.ReadFile(archivePath + ".sha256")
	if err != nil {
		t.Fatalf("missing checksum sidecar: %v", err)
	}
	recorded := strings.Fields(string(sidecar))[0]
	raw, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if actual := fmt.Sprintf("%x", sha256.Sum256(raw)); actual != recorded {
		t.Fatalf("sidecar sha256 %s != actual %s", recorded, actual)
	}

	// The freshly created archive passes end-to-end validation.
	if err := s.ValidateArchive(archivePath); err != nil {
		t.Fatalf("ValidateArchive on fresh backup: %v", err)
	}

	// Extract into a fresh dir and inspect.
	out := t.TempDir()
	if err := s.extractTarGz(archivePath, out); err != nil {
		t.Fatalf("extract: %v", err)
	}

	if _, err := os.Stat(filepath.Join(out, "point.db")); err != nil {
		t.Fatalf("archive is missing point.db: %v", err)
	}
	for _, sidecar := range []string{"point.db-wal", "point.db-shm"} {
		if _, err := os.Stat(filepath.Join(out, sidecar)); !os.IsNotExist(err) {
			t.Fatalf("archive should not contain %s", sidecar)
		}
	}

	// The snapshot must be a consistent, readable database with the seed row.
	db, err := sql.Open("sqlite", filepath.Join(out, "point.db"))
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}
	defer func() { _ = db.Close() }()

	var integrity string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("integrity_check = %q, want ok", integrity)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users WHERE username='mover'`).Scan(&count); err != nil {
		t.Fatalf("query snapshot: %v", err)
	}
	if count != 1 {
		t.Fatalf("snapshot missing seeded row (count=%d)", count)
	}
}
