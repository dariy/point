//go:build !unit

package services

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/repository"
)

// restoreCheckFixture is a data directory with a live database, one original,
// and one backup of both.
type restoreCheckFixture struct {
	svc      *SystemService
	dataPath string
	dbPath   string
	backup   string
}

const restoreCheckOriginal = "media/originals/2026/11/1_photo.jpg"

func newRestoreCheckFixture(t *testing.T) restoreCheckFixture {
	t.Helper()
	dataPath := t.TempDir()
	dbPath := filepath.Join(dataPath, "point.db")
	repo, err := repository.NewRepository(dbPath)
	if err != nil {
		t.Fatalf("open repo: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	if _, err := repo.DB().Exec(
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('checker','c@x.com','h','Checker')`,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	orig := filepath.Join(dataPath, filepath.FromSlash(restoreCheckOriginal))
	if err := os.MkdirAll(filepath.Dir(orig), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orig, []byte("original bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewSystemService(repo, dataPath, dbPath)
	name, _, err := svc.CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	return restoreCheckFixture{svc: svc, dataPath: dataPath, dbPath: dbPath, backup: name}
}

// rewriteArchive copies the archive src to dst entry by entry. edit may change
// the bytes of an entry, or return drop=true to leave it out.
func rewriteArchive(t *testing.T, src, dst string, edit func(name string, data []byte) (out []byte, drop bool)) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = in.Close() }()
	gr, err := gzip.NewReader(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := os.Create(dst)
	if err != nil {
		t.Fatal(err)
	}
	gw := gzip.NewWriter(out)
	tw := tar.NewWriter(gw)
	tr := tar.NewReader(gr)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		data, drop := edit(h.Name, data)
		if drop {
			continue
		}
		h.Size = int64(len(data))
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []io.Closer{tw, gw, out} {
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestVerifyBackup_GoodBackupPasses(t *testing.T) {
	f := newRestoreCheckFixture(t)

	liveDB, err := os.Stat(f.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	liveOrig, err := os.ReadFile(filepath.Join(f.dataPath, filepath.FromSlash(restoreCheckOriginal)))
	if err != nil {
		t.Fatal(err)
	}

	res, err := f.svc.VerifyBackup(context.Background(), "")
	if err != nil {
		t.Fatalf("VerifyBackup: %v", err)
	}
	if !res.Passed || !res.Manifest || res.Error != "" || res.MismatchCount != 0 {
		t.Fatalf("result = %+v, want a pass with a manifest", res)
	}
	if res.Backup != f.backup {
		t.Errorf("Backup = %q, want the newest backup %q", res.Backup, f.backup)
	}
	// The original and the database snapshot, nothing else.
	if res.Files != 2 || res.FilesExpected != 2 {
		t.Errorf("Files = %d, FilesExpected = %d; want 2 and 2", res.Files, res.FilesExpected)
	}
	if res.Tables["users"] != 1 {
		t.Errorf("Tables[users] = %d, want 1", res.Tables["users"])
	}

	// The live database and the media tree are as before.
	if after, err := os.Stat(f.dbPath); err != nil || !after.ModTime().Equal(liveDB.ModTime()) || after.Size() != liveDB.Size() {
		t.Errorf("the live database changed: before %v, after %v (%v)", liveDB, after, err)
	}
	if got, _ := os.ReadFile(filepath.Join(f.dataPath, filepath.FromSlash(restoreCheckOriginal))); string(got) != string(liveOrig) {
		t.Error("the live original changed")
	}
	if _, err := os.Stat(filepath.Join(f.dataPath, backupManifestName)); !os.IsNotExist(err) {
		t.Error("the check wrote the manifest into the data directory")
	}
	// The temporary directory is gone.
	entries, _ := os.ReadDir(filepath.Join(f.dataPath, "backups"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), restoreCheckDirPrefix) {
			t.Errorf("temporary directory %s was left behind", e.Name())
		}
	}

	// The result is stored, and a check is not due again for a week.
	last := f.svc.LastRestoreCheck()
	if last == nil || !last.Passed || last.Backup != f.backup || last.CheckedAt.IsZero() {
		t.Fatalf("LastRestoreCheck = %+v, want the stored pass", last)
	}
	if f.svc.RestoreCheckDue(RestoreCheckIntervalDays) {
		t.Error("RestoreCheckDue = true right after a check")
	}
}

func TestVerifyBackup_ChangedFileFails(t *testing.T) {
	f := newRestoreCheckFixture(t)
	backupDir := filepath.Join(f.dataPath, "backups")
	tampered := "backup_29990101_000000.tar.gz"
	rewriteArchive(t, filepath.Join(backupDir, f.backup), filepath.Join(backupDir, tampered),
		func(name string, data []byte) ([]byte, bool) {
			if name == restoreCheckOriginal {
				return []byte("changed bytes"), false
			}
			return data, false
		})

	res, err := f.svc.VerifyBackup(context.Background(), tampered)
	if err != nil {
		t.Fatalf("VerifyBackup: %v", err)
	}
	if res.Passed {
		t.Fatalf("result = %+v, want a fail", res)
	}
	if res.MismatchCount != 1 || len(res.Mismatches) != 1 || res.Mismatches[0] != "changed file: "+restoreCheckOriginal {
		t.Errorf("Mismatches = %v (count %d), want the one changed original", res.Mismatches, res.MismatchCount)
	}
	if last := f.svc.LastRestoreCheck(); last == nil || last.Passed {
		t.Errorf("LastRestoreCheck = %+v, want the stored fail", last)
	}
}

func TestVerifyBackup_MissingFileAndRowCountFail(t *testing.T) {
	f := newRestoreCheckFixture(t)
	backupDir := filepath.Join(f.dataPath, "backups")
	tampered := "backup_29990101_000000.tar.gz"
	rewriteArchive(t, filepath.Join(backupDir, f.backup), filepath.Join(backupDir, tampered),
		func(name string, data []byte) ([]byte, bool) {
			switch name {
			case restoreCheckOriginal:
				return nil, true
			case backupManifestName:
				var m backupManifest
				if err := json.Unmarshal(data, &m); err != nil {
					t.Fatal(err)
				}
				m.Tables["users"] = 5
				out, _ := json.Marshal(m)
				return out, false
			}
			return data, false
		})

	res, err := f.svc.VerifyBackup(context.Background(), tampered)
	if err != nil {
		t.Fatalf("VerifyBackup: %v", err)
	}
	want := []string{"missing file: " + restoreCheckOriginal, "table users: 1 rows, manifest says 5"}
	if res.Passed || res.MismatchCount != 2 || strings.Join(res.Mismatches, "|") != strings.Join(want, "|") {
		t.Errorf("result = %+v, want a fail with %v", res, want)
	}
}

func TestVerifyBackup_NoManifestPassesWithoutHashes(t *testing.T) {
	f := newRestoreCheckFixture(t)
	backupDir := filepath.Join(f.dataPath, "backups")
	old := "backup_29990101_000000.tar.gz"
	rewriteArchive(t, filepath.Join(backupDir, f.backup), filepath.Join(backupDir, old),
		func(name string, data []byte) ([]byte, bool) { return data, name == backupManifestName })

	res, err := f.svc.VerifyBackup(context.Background(), old)
	if err != nil {
		t.Fatalf("VerifyBackup: %v", err)
	}
	if !res.Passed || res.Manifest || res.Files != 2 || res.Tables["users"] != 1 {
		t.Errorf("result = %+v, want a pass with manifest=false", res)
	}
}

func TestVerifyBackup_UnknownManifestVersionFails(t *testing.T) {
	f := newRestoreCheckFixture(t)
	backupDir := filepath.Join(f.dataPath, "backups")
	future := "backup_29990101_000000.tar.gz"
	rewriteArchive(t, filepath.Join(backupDir, f.backup), filepath.Join(backupDir, future),
		func(name string, data []byte) ([]byte, bool) {
			if name == backupManifestName {
				return []byte(`{"version":99,"files":{},"tables":{}}`), false
			}
			return data, false
		})

	res, err := f.svc.VerifyBackup(context.Background(), future)
	if err != nil {
		t.Fatalf("VerifyBackup: %v", err)
	}
	if res.Passed || !strings.Contains(res.Error, "unknown manifest version 99") {
		t.Errorf("result = %+v, want a fail on the manifest version", res)
	}
}

func TestVerifyBackup_CorruptArchiveFails(t *testing.T) {
	f := newRestoreCheckFixture(t)
	backupDir := filepath.Join(f.dataPath, "backups")
	raw, err := os.ReadFile(filepath.Join(backupDir, f.backup))
	if err != nil {
		t.Fatal(err)
	}
	broken := "backup_29990101_000000.tar.gz"
	if err := os.WriteFile(filepath.Join(backupDir, broken), raw[:len(raw)/2], 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.VerifyBackup(context.Background(), broken)
	if err != nil {
		t.Fatalf("VerifyBackup: %v", err)
	}
	if res.Passed || !strings.Contains(res.Error, "does not unpack") {
		t.Errorf("result = %+v, want a fail on the unpack", res)
	}
}

func TestVerifyBackup_RefusesBadNames(t *testing.T) {
	f := newRestoreCheckFixture(t)
	for _, name := range []string{"../point.db", "missing.tar.gz", "restore_check.json"} {
		if _, err := f.svc.VerifyBackup(context.Background(), name); err == nil {
			t.Errorf("VerifyBackup(%q) = nil error, want a refusal", name)
		}
	}
	empty := NewSystemService(nil, t.TempDir(), "")
	if _, err := empty.VerifyBackup(context.Background(), ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("VerifyBackup with no backups = %v, want ErrNotFound", err)
	}
}

func TestVerifyBackup_RemovesStaleCheckDirs(t *testing.T) {
	f := newRestoreCheckFixture(t)
	stale := filepath.Join(f.dataPath, "backups", restoreCheckDirPrefix+"crashed")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.VerifyBackup(context.Background(), f.backup); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("a stale check directory was not removed")
	}
}

// A real restore leaves the manifest out of the data directory.
func TestExtractTarGz_LeavesManifestOut(t *testing.T) {
	f := newRestoreCheckFixture(t)
	out := t.TempDir()
	if err := f.svc.extractTarGz(filepath.Join(f.dataPath, "backups", f.backup), out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, backupManifestName)); !os.IsNotExist(err) {
		t.Error("extractTarGz wrote the manifest")
	}
	if _, err := os.Stat(filepath.Join(out, filepath.FromSlash(restoreCheckOriginal))); err != nil {
		t.Errorf("extractTarGz lost the original: %v", err)
	}
}
