package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

// makeArchive builds an in-memory .tar.gz from name→content entries.
func makeArchive(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestUploadBackupArchive_StagesValidArchive(t *testing.T) {
	h, _, _ := newBackupTestHandler(t)
	archive := makeArchive(t, map[string]string{"point.db": "dbbytes", "media/a.txt": "hi"})

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/system/backups/upload", bytes.NewReader(archive))
	rec := httptest.NewRecorder()
	if err := h.UploadBackupArchive(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UploadBackupArchive: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	var res map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	name := res["filename"]
	if !strings.HasPrefix(name, "imported_") || !strings.HasSuffix(name, ".tar.gz") {
		t.Fatalf("unexpected filename %q", name)
	}

	backupDir := filepath.Join(h.dataPath, "backups")
	// The archive is staged (final name present, checksum sidecar written, no .partial).
	if _, err := os.Stat(filepath.Join(backupDir, name)); err != nil {
		t.Fatalf("staged archive missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(backupDir, name+".sha256")); err != nil {
		t.Fatalf("checksum sidecar missing: %v", err)
	}
	files, _ := os.ReadDir(backupDir)
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".partial") {
			t.Fatalf("a .partial was left behind: %s", f.Name())
		}
	}
}

func TestUploadBackupArchive_RejectsInvalid(t *testing.T) {
	h, _, _ := newBackupTestHandler(t)

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/system/backups/upload", strings.NewReader("not a gzip archive"))
	rec := httptest.NewRecorder()
	err := h.UploadBackupArchive(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected an error for a non-archive upload")
	}

	// Nothing must be left staged in the backups dir.
	files, _ := os.ReadDir(filepath.Join(h.dataPath, "backups"))
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".partial") {
			t.Fatalf("invalid upload left a .partial: %s", f.Name())
		}
		if strings.HasPrefix(f.Name(), "imported_") {
			t.Fatalf("invalid upload was staged: %s", f.Name())
		}
	}
}
