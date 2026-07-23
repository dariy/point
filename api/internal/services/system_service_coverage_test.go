package services

import (
	"archive/tar"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHumanizeBytes(t *testing.T) {
	cases := []struct {
		n    int64
		want string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1024, "1.0 KiB"},
		{1536, "1.5 KiB"},
		{1024 * 1024, "1.0 MiB"},
		{1024 * 1024 * 1024, "1.0 GiB"},
		{1024 * 1024 * 1024 * 1024, "1.0 TiB"},
	}
	for _, c := range cases {
		if got := humanizeBytes(c.n); got != c.want {
			t.Errorf("humanizeBytes(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}

// TestCheckBackupSpace_EmptyDataDir: an empty data dir has nothing to archive, so
// the space check is a no-op that never blocks a backup.
func TestCheckBackupSpace_EmptyDataDir(t *testing.T) {
	s := NewSystemService(nil, t.TempDir(), "")
	if err := s.CheckBackupSpace(); err != nil {
		t.Fatalf("CheckBackupSpace on an empty dir should pass: %v", err)
	}
}

// TestCreateBackup_RefusesConcurrentRun: only one backup may run at a time; a
// second call while one is in flight returns ErrBackupInProgress.
func TestCreateBackup_RefusesConcurrentRun(t *testing.T) {
	s := NewSystemService(nil, t.TempDir(), "")
	// Simulate an in-flight backup holding the run guard.
	s.backupMu.Lock()
	s.backupRunning = true
	s.backupMu.Unlock()

	if _, _, err := s.CreateBackup(context.Background()); err != ErrBackupInProgress {
		t.Fatalf("CreateBackup while running: got %v, want ErrBackupInProgress", err)
	}
}

// TestCleanupPartialBackups_MissingDir: a data dir with no backups folder is not
// an error — there is simply nothing to clean up.
func TestCleanupPartialBackups_MissingDir(t *testing.T) {
	s := NewSystemService(nil, t.TempDir(), "")
	// Must not panic or fail when the backups dir doesn't exist yet.
	s.CleanupPartialBackups()
}

func TestAddFileToTar_MissingSource(t *testing.T) {
	tw := tar.NewWriter(io.Discard)
	defer func() { _ = tw.Close() }()
	if err := addFileToTar(tw, filepath.Join(t.TempDir(), "does-not-exist"), "x"); err == nil {
		t.Fatal("addFileToTar with a missing source should error")
	}
}

// TestScheduleRestore_RejectsInvalidArchive: ScheduleRestore validates the
// archive up front so a restore known to fail at boot is never scheduled.
func TestScheduleRestore_RejectsInvalidArchive(t *testing.T) {
	dataPath := t.TempDir()
	backupDir := filepath.Join(dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// A well-formed archive that carries no database → not a Point backup.
	writeTarGz(t, filepath.Join(backupDir, "nodb.tar.gz"), map[string]string{"media/a.txt": "hi"})

	s := NewSystemService(nil, dataPath, "")
	if err := s.ScheduleRestore("nodb.tar.gz"); err == nil {
		t.Fatal("ScheduleRestore should reject an archive without a database")
	}
	if _, err := os.Stat(filepath.Join(backupDir, pendingRestoreMarker)); !os.IsNotExist(err) {
		t.Fatal("no restore marker should be written for an invalid archive")
	}
}

func TestScheduleRestore_RejectsUnsafeName(t *testing.T) {
	s := NewSystemService(nil, t.TempDir(), "")
	if err := s.ScheduleRestore("../escape.tar.gz"); err == nil {
		t.Fatal("ScheduleRestore should reject a traversal filename")
	}
	if err := s.ScheduleRestore("missing.tar.gz"); err == nil {
		t.Fatal("ScheduleRestore should reject a non-existent backup")
	}
}

// TestApplyPendingRestore_RejectsUnsafeMarker: a marker naming an unsafe path is
// rejected, but still consumed so a bad marker can't loop the boot.
func TestApplyPendingRestore_RejectsUnsafeMarker(t *testing.T) {
	dataPath := t.TempDir()
	backupDir := filepath.Join(dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(backupDir, pendingRestoreMarker)
	if err := os.WriteFile(marker, []byte("../evil.tar.gz"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := NewSystemService(nil, dataPath, "")
	applied, err := s.ApplyPendingRestore()
	if !applied || err == nil {
		t.Fatalf("ApplyPendingRestore with unsafe marker: applied=%v err=%v, want (true, error)", applied, err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("marker should be consumed even when the restore is rejected")
	}
}

// TestApplyPendingRestore_CorruptArchive: a marker pointing at a corrupt archive
// surfaces the extraction error (and consumes the marker).
func TestApplyPendingRestore_CorruptArchive(t *testing.T) {
	dataPath := t.TempDir()
	backupDir := filepath.Join(dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backupDir, "bad.tar.gz"), []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(backupDir, pendingRestoreMarker)
	if err := os.WriteFile(marker, []byte("bad.tar.gz"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := NewSystemService(nil, dataPath, "")
	applied, err := s.ApplyPendingRestore()
	if !applied || err == nil {
		t.Fatalf("ApplyPendingRestore with corrupt archive: applied=%v err=%v, want (true, error)", applied, err)
	}
	if !strings.Contains(err.Error(), "bad.tar.gz") {
		t.Fatalf("error should name the archive: %v", err)
	}
}

func TestValidateArchive_MissingFile(t *testing.T) {
	s := NewSystemService(nil, t.TempDir(), "")
	if err := s.ValidateArchive(filepath.Join(t.TempDir(), "nope.tar.gz")); err == nil {
		t.Fatal("ValidateArchive on a missing file should error")
	}
}

// TestCreateTarGz_UnwritableDest: a destination inside a non-existent directory
// can't be created, so archiving fails cleanly.
func TestCreateTarGz_UnwritableDest(t *testing.T) {
	s := NewSystemService(nil, t.TempDir(), "")
	dest := filepath.Join(t.TempDir(), "no-such-dir", "out.tar.gz")
	if _, err := s.createTarGz(context.Background(), dest); err == nil {
		t.Fatal("createTarGz to an uncreatable path should error")
	}
}
