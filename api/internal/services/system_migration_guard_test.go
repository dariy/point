package services

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// guardFixture builds a data dir holding a "database" and a "snapshot" as plain
// files. Nothing here needs SQLite: the restore path is file mechanics, and the
// mechanics are what has to be right. The end-to-end proof with a real database
// lives in internal/migrations (guard_integration_test.go).
func guardFixture(t *testing.T, dbBytes, snapBytes string) (*SystemService, string, string) {
	t.Helper()
	dataPath := t.TempDir()
	dbPath := filepath.Join(dataPath, "point.db")
	if err := os.WriteFile(dbPath, []byte(dbBytes), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSystemService(nil, dataPath, dbPath)
	if err := os.MkdirAll(s.migrationSnapshotDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	snap := filepath.Join(s.migrationSnapshotDir(), "premigration_20260101_000000.db")
	if err := os.WriteFile(snap, []byte(snapBytes), 0o644); err != nil {
		t.Fatal(err)
	}
	return s, dbPath, snap
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func TestRestoreDBSnapshot_ReplacesDBAtomically(t *testing.T) {
	s, dbPath, snap := guardFixture(t, "half-migrated", "good-snapshot")
	// Sidecars belonging to the database being replaced.
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.WriteFile(dbPath+suffix, []byte("stale"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if err := s.RestoreDBSnapshot(snap, errors.New("tag_flags_from_system_tags: no such table: tags")); err != nil {
		t.Fatalf("RestoreDBSnapshot: %v", err)
	}

	if got := readFile(t, dbPath); got != "good-snapshot" {
		t.Errorf("database holds %q, want the snapshot bytes", got)
	}
	// Leaving these would make SQLite replay the old WAL into the restored file.
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(dbPath + suffix); !os.IsNotExist(err) {
			t.Errorf("%s sidecar survived the restore", suffix)
		}
	}
	if _, err := os.Stat(dbPath + restoringSuffix); !os.IsNotExist(err) {
		t.Error("staging file survived the restore")
	}
	if _, err := os.Stat(filepath.Join(s.migrationSnapshotDir(), migrationRestoreMarker)); !os.IsNotExist(err) {
		t.Error("restore marker survived a completed restore")
	}

	// The broken database is kept for diagnosis, with a note saying why.
	entries, _ := os.ReadDir(s.migrationSnapshotDir())
	var failedDB, failedTxt string
	for _, e := range entries {
		switch {
		case strings.HasPrefix(e.Name(), migrationFailedPrefix) && strings.HasSuffix(e.Name(), ".db"):
			failedDB = e.Name()
		case strings.HasPrefix(e.Name(), migrationFailedPrefix) && strings.HasSuffix(e.Name(), ".txt"):
			failedTxt = e.Name()
		}
	}
	if failedDB == "" {
		t.Fatal("the failed database was not preserved")
	}
	if got := readFile(t, filepath.Join(s.migrationSnapshotDir(), failedDB)); got != "half-migrated" {
		t.Errorf("preserved database holds %q, want the pre-restore bytes", got)
	}
	if failedTxt == "" {
		t.Fatal("no note explaining the restore was written")
	}
	if note := readFile(t, filepath.Join(s.migrationSnapshotDir(), failedTxt)); !strings.Contains(note, "no such table: tags") {
		t.Errorf("note does not carry the migration error: %q", note)
	}
}

func TestRestoreDBSnapshot_MissingSnapshotLeavesDBIntact(t *testing.T) {
	s, dbPath, snap := guardFixture(t, "live-data", "")
	// An empty snapshot is not a safety net; nor is one that isn't there.
	for _, tc := range []struct{ name, path string }{
		{"empty", snap},
		{"absent", filepath.Join(s.migrationSnapshotDir(), "nope.db")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := s.RestoreDBSnapshot(tc.path, nil); err == nil {
				t.Fatal("RestoreDBSnapshot succeeded with an unusable snapshot")
			}
			if got := readFile(t, dbPath); got != "live-data" {
				t.Errorf("database was modified (%q) despite the restore failing", got)
			}
		})
	}
}

// An absent point.db makes the next boot initialize a fresh empty database from
// schema.sql — silent, total data loss. Nothing in the restore may open that
// window, so assert the file exists at every observable point.
func TestRestoreDBSnapshot_NeverLeavesDBPathMissing(t *testing.T) {
	s, dbPath, snap := guardFixture(t, "half-migrated", "good-snapshot")

	done := make(chan struct{})
	missing := make(chan struct{}, 1)
	go func() {
		for {
			select {
			case <-done:
				return
			default:
			}
			if _, err := os.Stat(dbPath); os.IsNotExist(err) {
				select {
				case missing <- struct{}{}:
				default:
				}
				return
			}
		}
	}()

	if err := s.RestoreDBSnapshot(snap, nil); err != nil {
		t.Fatalf("RestoreDBSnapshot: %v", err)
	}
	close(done)

	select {
	case <-missing:
		t.Fatal("the database path was empty at some point during the restore")
	default:
	}
}

func TestApplyPendingMigrationRestore_ResumesFromMarker(t *testing.T) {
	s, dbPath, snap := guardFixture(t, "half-migrated", "good-snapshot")
	// The state a crash between the marker write and the rename leaves behind.
	if err := os.WriteFile(filepath.Join(s.migrationSnapshotDir(), migrationRestoreMarker),
		[]byte(filepath.Base(snap)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dbPath+restoringSuffix, []byte("partial-cop"), 0o644); err != nil {
		t.Fatal(err)
	}

	applied, err := s.ApplyPendingMigrationRestore()
	if err != nil {
		t.Fatalf("ApplyPendingMigrationRestore: %v", err)
	}
	if !applied {
		t.Fatal("a pending restore was not reported as applied")
	}
	if got := readFile(t, dbPath); got != "good-snapshot" {
		t.Errorf("database holds %q, want the snapshot bytes", got)
	}
	if _, err := os.Stat(filepath.Join(s.migrationSnapshotDir(), migrationRestoreMarker)); !os.IsNotExist(err) {
		t.Error("marker survived a completed restore")
	}
	if _, err := os.Stat(dbPath + restoringSuffix); !os.IsNotExist(err) {
		t.Error("the interrupted staging file was left behind")
	}
}

func TestApplyPendingMigrationRestore_NoMarkerIsNoop(t *testing.T) {
	s, dbPath, _ := guardFixture(t, "live-data", "snapshot")

	applied, err := s.ApplyPendingMigrationRestore()
	if err != nil || applied {
		t.Fatalf("got (%v, %v), want (false, nil) with no marker", applied, err)
	}
	if got := readFile(t, dbPath); got != "live-data" {
		t.Errorf("database was modified (%q) with no restore pending", got)
	}
}

func TestApplyPendingMigrationRestore_RejectsUnsafeMarker(t *testing.T) {
	s, dbPath, _ := guardFixture(t, "live-data", "snapshot")
	if err := os.WriteFile(filepath.Join(s.migrationSnapshotDir(), migrationRestoreMarker),
		[]byte("../../etc/passwd"), 0o644); err != nil {
		t.Fatal(err)
	}

	applied, err := s.ApplyPendingMigrationRestore()
	if err == nil {
		t.Fatal("a traversing marker was accepted")
	}
	if !applied {
		t.Error("a marker that exists should report applied=true even when it fails")
	}
	if got := readFile(t, dbPath); got != "live-data" {
		t.Errorf("database was modified (%q) by a rejected marker", got)
	}
}

func TestPruneMigrationSnapshots_KeepsNewest(t *testing.T) {
	s, _, _ := guardFixture(t, "db", "snap")
	dir := s.migrationSnapshotDir()

	write := func(name string, age time.Duration) {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-age)
		if err := os.Chtimes(p, when, when); err != nil {
			t.Fatal(err)
		}
	}
	// Five snapshots, five preserved failures with their notes, plus files that
	// belong to the user-facing backup machinery and must not be touched.
	for i := 1; i <= 5; i++ {
		write("premigration_2026010"+string(rune('0'+i))+"_000000.db", time.Duration(i)*time.Hour)
		write("failed_2026010"+string(rune('0'+i))+"_000000.db", time.Duration(i)*time.Hour)
		write("failed_2026010"+string(rune('0'+i))+"_000000.txt", time.Duration(i)*time.Hour)
	}
	// The fixture already wrote one premigration_ file; drop it so the counts
	// below are about what this test set up.
	_ = os.Remove(filepath.Join(dir, "premigration_20260101_000000.db"))
	if err := os.WriteFile(filepath.Join(s.dataPath, "backups", "backup_20260101_000000.tar.gz"), []byte("archive"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dataPath, "backups", pendingRestoreMarker), []byte("backup_20260101_000000.tar.gz"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := s.pruneMigrationSnapshots(2); err != nil {
		t.Fatalf("pruneMigrationSnapshots: %v", err)
	}

	var snaps, faileds, notes int
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		switch {
		case strings.HasPrefix(e.Name(), migrationSnapshotPrefix):
			snaps++
		case strings.HasSuffix(e.Name(), ".txt"):
			notes++
		case strings.HasPrefix(e.Name(), migrationFailedPrefix):
			faileds++
		}
	}
	if snaps != 2 || faileds != 2 || notes != 2 {
		t.Errorf("after pruning to 2: %d snapshots, %d failed copies, %d notes; want 2/2/2", snaps, faileds, notes)
	}
	// Newest kept: the 1h-old ones, not the 5h-old ones.
	if _, err := os.Stat(filepath.Join(dir, "premigration_20260101_000000.db")); err == nil {
		t.Error("pruning kept an older snapshot over a newer one")
	}
	for _, keep := range []string{"backup_20260101_000000.tar.gz", pendingRestoreMarker} {
		if _, err := os.Stat(filepath.Join(s.dataPath, "backups", keep)); err != nil {
			t.Errorf("pruning removed %s, which belongs to the user-facing backups", keep)
		}
	}
}

// The snapshots live under backups/migrations/. Rotation of the user's archives
// must not see them — it matches only *.tar.gz and skips directories, and that
// has to stay true.
func TestRotateBackups_IgnoresMigrationSnapshots(t *testing.T) {
	s, _, _ := guardFixture(t, "db", "snap")
	backupDir := filepath.Join(s.dataPath, "backups")
	for i := 1; i <= 3; i++ {
		name := filepath.Join(backupDir, "backup_2026010"+string(rune('0'+i))+"_000000.tar.gz")
		if err := os.WriteFile(name, []byte("archive"), 0o644); err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-time.Duration(i) * time.Hour)
		if err := os.Chtimes(name, when, when); err != nil {
			t.Fatal(err)
		}
	}

	deleted, err := s.RotateBackups(1)
	if err != nil {
		t.Fatalf("RotateBackups: %v", err)
	}
	if deleted != 2 {
		t.Errorf("RotateBackups deleted %d archives, want 2", deleted)
	}
	if _, err := os.Stat(filepath.Join(s.migrationSnapshotDir(), "premigration_20260101_000000.db")); err != nil {
		t.Errorf("RotateBackups reached into backups/migrations/: %v", err)
	}
}
