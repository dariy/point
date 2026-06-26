package services

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeBackup creates a fake .tar.gz in the backups dir with the given modtime.
func writeBackup(t *testing.T, dataPath, name string, mod time.Time) {
	t.Helper()
	dir := filepath.Join(dataPath, "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mod, mod); err != nil {
		t.Fatal(err)
	}
}

func countBackups(t *testing.T, dataPath string) int {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dataPath, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

func TestRotateBackups(t *testing.T) {
	dp := t.TempDir()
	s := NewSystemService(nil, dp)

	// No backups dir yet → nothing to do.
	if n, err := s.RotateBackups(3); err != nil || n != 0 {
		t.Fatalf("missing dir: got (%d,%v), want (0,nil)", n, err)
	}

	now := time.Now()
	for i := 0; i < 5; i++ {
		writeBackup(t, dp, fmt.Sprintf("backup_%d.tar.gz", i), now.Add(-time.Duration(i)*time.Hour))
	}

	// keep <= 0 disables rotation.
	if n, err := s.RotateBackups(0); err != nil || n != 0 {
		t.Fatalf("keep=0: got (%d,%v), want (0,nil)", n, err)
	}
	if c := countBackups(t, dp); c != 5 {
		t.Fatalf("keep=0 should delete nothing, have %d", c)
	}

	// keep 3 of 5 → 2 deleted, newest survive.
	deleted, err := s.RotateBackups(3)
	if err != nil || deleted != 2 {
		t.Fatalf("RotateBackups(3): got (%d,%v), want (2,nil)", deleted, err)
	}
	if c := countBackups(t, dp); c != 3 {
		t.Fatalf("expected 3 backups left, have %d", c)
	}
	// The deleted ones are the oldest (i=3,4 → 3h,4h old).
	for _, gone := range []string{"backup_3.tar.gz", "backup_4.tar.gz"} {
		if _, err := os.Stat(filepath.Join(dp, "backups", gone)); !os.IsNotExist(err) {
			t.Fatalf("%s should have been deleted", gone)
		}
	}
}

func TestBackupDue(t *testing.T) {
	dp := t.TempDir()
	s := NewSystemService(nil, dp)

	// Daily is always due regardless of history.
	if !s.BackupDue(1) {
		t.Fatal("daily cadence should always be due")
	}
	// No backups yet → due at any cadence.
	if !s.BackupDue(7) {
		t.Fatal("missing backups should be due")
	}

	// A fresh backup makes a weekly cadence not yet due...
	writeBackup(t, dp, "backup_recent.tar.gz", time.Now())
	if s.BackupDue(7) {
		t.Fatal("weekly cadence with a fresh backup should not be due")
	}
	// ...but an 8-day-old backup is.
	writeBackup(t, dp, "backup_recent.tar.gz", time.Now().Add(-8*24*time.Hour))
	if !s.BackupDue(7) {
		t.Fatal("weekly cadence with an 8-day-old backup should be due")
	}
}
