package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateBackup_LeavesNoPartial(t *testing.T) {
	dataPath := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataPath, "point.db"), []byte("db-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSystemService(nil, dataPath, "") // dbPath "" → no VACUUM snapshot, no repo needed

	name, _, err := s.CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	backupDir := filepath.Join(dataPath, "backups")
	if _, err := os.Stat(filepath.Join(backupDir, name)); err != nil {
		t.Fatalf("final backup missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(backupDir, name+".sha256")); err != nil {
		t.Fatalf("checksum sidecar missing: %v", err)
	}
	entries, _ := os.ReadDir(backupDir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".partial") {
			t.Fatalf("a .partial file was left behind: %s", e.Name())
		}
	}
	if s.BackupRunning() {
		t.Fatal("BackupRunning should be false after completion")
	}
}

func TestCleanupPartialBackups(t *testing.T) {
	dataPath := t.TempDir()
	backupDir := filepath.Join(dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	partial := filepath.Join(backupDir, "backup_x.tar.gz.partial")
	finished := filepath.Join(backupDir, "backup_y.tar.gz")
	_ = os.WriteFile(partial, []byte("half"), 0o644)
	_ = os.WriteFile(finished, []byte("done"), 0o644)

	NewSystemService(nil, dataPath, "").CleanupPartialBackups()

	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatal("stale .partial should have been removed")
	}
	if _, err := os.Stat(finished); err != nil {
		t.Fatal("finished backup should not have been removed")
	}
}

// writeTarGz builds a .tar.gz at path from the given name→content entries.
func writeTarGz(t *testing.T, path string, entries map[string]string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range entries {
		if err := tw.WriteHeader(&tar.Header{
			Name:     name,
			Mode:     0o644,
			Size:     int64(len(content)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreFromArchive_RejectsTraversal(t *testing.T) {
	root := t.TempDir()
	dataPath := filepath.Join(root, "data")
	if err := os.MkdirAll(dataPath, 0o755); err != nil {
		t.Fatal(err)
	}
	s := NewSystemService(nil, dataPath, "")

	// An entry that would escape into a sibling dir via "../".
	archive := filepath.Join(root, "evil.tar.gz")
	writeTarGz(t, archive, map[string]string{"../escape.txt": "pwned"})

	if err := s.RestoreFromArchive(archive); err == nil {
		t.Fatal("expected traversal entry to be rejected")
	}
	// The escaped file must not have been written outside dataPath.
	if _, err := os.Stat(filepath.Join(root, "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("traversal wrote a file outside the data dir")
	}
}

func TestRestoreFromArchive_RejectsAbsolutePath(t *testing.T) {
	root := t.TempDir()
	dataPath := filepath.Join(root, "data")
	if err := os.MkdirAll(dataPath, 0o755); err != nil {
		t.Fatal(err)
	}
	s := NewSystemService(nil, dataPath, "")

	absTarget := filepath.Join(root, "abs-escape.txt")
	archive := filepath.Join(root, "abs.tar.gz")
	writeTarGz(t, archive, map[string]string{absTarget: "pwned"})

	if err := s.RestoreFromArchive(archive); err == nil {
		t.Fatal("expected absolute-path entry to be rejected")
	}
	if _, err := os.Stat(absTarget); !os.IsNotExist(err) {
		t.Fatal("absolute-path entry wrote outside the data dir")
	}
}

func TestValidateArchive_AcceptsBackup(t *testing.T) {
	root := t.TempDir()
	s := NewSystemService(nil, filepath.Join(root, "data"), "")

	archive := filepath.Join(root, "ok.tar.gz")
	writeTarGz(t, archive, map[string]string{"point.db": "dbbytes", "media/a.txt": "hi"})

	if err := s.ValidateArchive(archive); err != nil {
		t.Fatalf("valid backup rejected: %v", err)
	}
}

func TestValidateArchive_RejectsNonBackup(t *testing.T) {
	root := t.TempDir()
	s := NewSystemService(nil, filepath.Join(root, "data"), "")

	// Well-formed archive, but it carries no database → not a Point backup.
	archive := filepath.Join(root, "nodb.tar.gz")
	writeTarGz(t, archive, map[string]string{"media/a.txt": "hi"})

	if err := s.ValidateArchive(archive); err == nil {
		t.Fatal("archive without a database should be rejected")
	}
}

func TestValidateArchive_RejectsTruncated(t *testing.T) {
	root := t.TempDir()
	s := NewSystemService(nil, filepath.Join(root, "data"), "")

	archive := filepath.Join(root, "trunc.tar.gz")
	writeTarGz(t, archive, map[string]string{"point.db": "0123456789abcdefghijklmnopqrstuvwxyz"})
	info, err := os.Stat(archive)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(archive, info.Size()/2); err != nil {
		t.Fatal(err)
	}

	if err := s.ValidateArchive(archive); err == nil {
		t.Fatal("truncated archive should be rejected")
	}
}

func TestValidateArchive_RejectsNonGzip(t *testing.T) {
	root := t.TempDir()
	s := NewSystemService(nil, filepath.Join(root, "data"), "")

	archive := filepath.Join(root, "junk.tar.gz")
	if err := os.WriteFile(archive, []byte("this is not a gzip stream"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := s.ValidateArchive(archive); err == nil {
		t.Fatal("non-gzip file should be rejected")
	}
}

func TestRestoreFromArchive_ExtractsSafeEntries(t *testing.T) {
	root := t.TempDir()
	dataPath := filepath.Join(root, "data")
	if err := os.MkdirAll(dataPath, 0o755); err != nil {
		t.Fatal(err)
	}
	s := NewSystemService(nil, dataPath, "")

	archive := filepath.Join(root, "ok.tar.gz")
	writeTarGz(t, archive, map[string]string{"media/a.txt": "hello"})

	if err := s.RestoreFromArchive(archive); err != nil {
		t.Fatalf("RestoreFromArchive: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dataPath, "media", "a.txt"))
	if err != nil {
		t.Fatalf("expected extracted file: %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("content = %q, want hello", got)
	}
}
