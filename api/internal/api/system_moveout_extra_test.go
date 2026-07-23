package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// seedAdmin inserts a user whose password is the sha256-hex the client sends
// (the server stores Argon2id of it), and returns that password.
func seedAdmin(t *testing.T, h *SystemHandler) string {
	t.Helper()
	pw := "clientsha256hex"
	hash, err := services.HashPassword(pw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.repo.DB().Exec(
		`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'admin','a@b.c',?,'Admin')`, hash,
	); err != nil {
		t.Fatal(err)
	}
	return pw
}

func newAuthorizeCtx(e *echo.Echo, filename, body string) (echo.Context, *httptest.ResponseRecorder) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues(filename)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	return c, rec
}

func TestAuthorizeBackupDownload(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	pw := seedAdmin(t, h)
	e := echo.New()

	// Invalid filename → 400 before any password check.
	if c, _ := newAuthorizeCtx(e, "../evil", `{"current_name":"`+pw+`"}`); h.AuthorizeBackupDownload(c) == nil {
		t.Fatal("traversal filename should be rejected")
	}

	// Malformed body → 400.
	if c, _ := newAuthorizeCtx(e, filename, `{`); h.AuthorizeBackupDownload(c) == nil {
		t.Fatal("malformed body should be rejected")
	}

	// Wrong password → 403.
	if c, _ := newAuthorizeCtx(e, filename, `{"current_name":"wrong"}`); h.AuthorizeBackupDownload(c) == nil {
		t.Fatal("wrong password should be rejected")
	}

	// Correct password but unknown backup → 404.
	if c, _ := newAuthorizeCtx(e, "backup_missing.tar.gz", `{"current_name":"`+pw+`"}`); h.AuthorizeBackupDownload(c) == nil {
		t.Fatal("unknown backup should 404")
	}

	// Correct password + existing backup → a usable token.
	c, rec := newAuthorizeCtx(e, filename, `{"current_name":"`+pw+`"}`)
	if err := h.AuthorizeBackupDownload(c); err != nil {
		t.Fatalf("AuthorizeBackupDownload: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var res map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if uid, file, ok := h.downloadTokens.Consume(res["token"]); !ok || uid != 1 || file != filename {
		t.Fatalf("issued token invalid: uid=%d file=%q ok=%v", uid, file, ok)
	}
}

// TestDownloadBackup_AdvertisesChecksum: when a checksum sidecar exists, the
// download response carries it in the X-Archive-SHA256 header.
func TestDownloadBackup_AdvertisesChecksum(t *testing.T) {
	h, filename, content := newBackupTestHandler(t)
	sum := sha256.Sum256(content)
	sumHex := hex.EncodeToString(sum[:])
	sidecar := filepath.Join(h.dataPath, "backups", filename+".sha256")
	if err := os.WriteFile(sidecar, []byte(sumHex+"  "+filename+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	e := echo.New()
	token, _ := h.downloadTokens.Issue(1, filename)
	req := httptest.NewRequest(http.MethodGet, "/?token="+token, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues(filename)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.DownloadBackup(c); err != nil {
		t.Fatalf("DownloadBackup: %v", err)
	}
	if got := rec.Header().Get("X-Archive-SHA256"); got != sumHex {
		t.Fatalf("X-Archive-SHA256 = %q, want %q", got, sumHex)
	}
}

// TestDownloadBackup_FileVanished: a token can validate but the archive may have
// been deleted in the meantime → 404 rather than a broken stream.
func TestDownloadBackup_FileVanished(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	e := echo.New()
	token, _ := h.downloadTokens.Issue(1, filename)
	if err := os.Remove(filepath.Join(h.dataPath, "backups", filename)); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/?token="+token, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues(filename)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.DownloadBackup(c); err == nil {
		t.Fatal("download of a vanished backup should fail")
	}
}

func TestRestoreBackup_InvalidBody(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	seedAdmin(t, h)
	e := echo.New()

	c, _ := newAuthorizeCtx(e, filename, `{not json`)
	if err := h.RestoreBackup(c); err == nil {
		t.Fatal("malformed body should be rejected")
	}
}

// TestRestoreBackup_ScheduleFails: a correct password but an archive that fails
// validation (no database) is rejected by ScheduleRestore.
func TestRestoreBackup_ScheduleFails(t *testing.T) {
	h, _, _ := newBackupTestHandler(t)
	pw := seedAdmin(t, h)
	e := echo.New()

	name := "backup_nodb.tar.gz"
	if err := os.WriteFile(filepath.Join(h.dataPath, "backups", name),
		makeArchive(t, map[string]string{"media/a.txt": "hi"}), 0o644); err != nil {
		t.Fatal(err)
	}

	c, _ := newAuthorizeCtx(e, name, `{"current_name":"`+pw+`"}`)
	if err := h.RestoreBackup(c); err == nil {
		t.Fatal("restoring an archive without a database should fail")
	}
	if _, err := os.Stat(filepath.Join(h.dataPath, "backups", "pending_restore")); !os.IsNotExist(err) {
		t.Fatal("no restore should be scheduled when validation fails")
	}
}

func TestDeleteBackup(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	e := echo.New()
	// Give it a checksum sidecar so we can confirm the orphan is cleaned up too.
	sidecar := filepath.Join(h.dataPath, "backups", filename+".sha256")
	if err := os.WriteFile(sidecar, []byte("deadbeef  "+filename+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	newCtx := func(name string) (echo.Context, *httptest.ResponseRecorder) {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("filename")
		c.SetParamValues(name)
		return c, rec
	}

	// Traversal name → 400.
	if c, _ := newCtx("../etc/passwd"); h.DeleteBackup(c) == nil {
		t.Fatal("traversal filename should be rejected")
	}
	// Unknown file → 404.
	if c, _ := newCtx("backup_missing.tar.gz"); h.DeleteBackup(c) == nil {
		t.Fatal("deleting a missing backup should 404")
	}
	// Existing file → deleted along with its sidecar.
	c, rec := newCtx(filename)
	if err := h.DeleteBackup(c); err != nil {
		t.Fatalf("DeleteBackup: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(h.dataPath, "backups", filename)); !os.IsNotExist(err) {
		t.Fatal("backup file should have been deleted")
	}
	if _, err := os.Stat(sidecar); !os.IsNotExist(err) {
		t.Fatal("orphaned checksum sidecar should have been deleted")
	}
}

// TestListBackups_ReportsChecksum confirms the sidecar checksum surfaces in the
// listing (exercises readChecksumSidecar).
func TestListBackups_ReportsChecksum(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	e := echo.New()
	if err := os.WriteFile(filepath.Join(h.dataPath, "backups", filename+".sha256"),
		[]byte("abc123  "+filename+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ListBackups(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, b := range list {
		if b["filename"] == filename {
			found = true
			if b["sha256"] != "abc123" {
				t.Fatalf("sha256 = %v, want abc123", b["sha256"])
			}
		}
	}
	if !found {
		t.Fatalf("backup %q missing from listing", filename)
	}
}

// TestListBackups_EmptySidecar: an empty (or whitespace-only) checksum sidecar
// yields no checksum rather than a panic or a garbage value.
func TestListBackups_EmptySidecar(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	e := echo.New()
	if err := os.WriteFile(filepath.Join(h.dataPath, "backups", filename+".sha256"), []byte("   \n"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ListBackups(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	for _, b := range list {
		if b["filename"] == filename {
			if s, ok := b["sha256"]; ok && s != "" {
				t.Fatalf("empty sidecar should yield no checksum, got %v", s)
			}
		}
	}
}

// TestUploadBackupArchive_ChecksumHeader covers the client-supplied-checksum
// path: a matching digest publishes the archive, a mismatch is rejected.
func TestUploadBackupArchive_ChecksumHeader(t *testing.T) {
	h, _, _ := newBackupTestHandler(t)
	e := echo.New()
	archive := makeArchive(t, map[string]string{"point.db": "dbbytes"})
	sum := sha256.Sum256(archive)
	sumHex := hex.EncodeToString(sum[:])

	// Matching checksum → published.
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(archive)))
	req.Header.Set("X-Archive-SHA256", sumHex)
	rec := httptest.NewRecorder()
	if err := h.UploadBackupArchive(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UploadBackupArchive: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	// Mismatched checksum → rejected, nothing staged.
	req2 := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(archive)))
	req2.Header.Set("X-Archive-SHA256", "0000")
	rec2 := httptest.NewRecorder()
	if err := h.UploadBackupArchive(e.NewContext(req2, rec2)); err == nil {
		t.Fatal("a checksum mismatch should be rejected")
	}
	files, _ := os.ReadDir(filepath.Join(h.dataPath, "backups"))
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".partial") {
			t.Fatalf("mismatched upload left a .partial: %s", f.Name())
		}
	}
}

// TestCreateBackup_Handler covers the synchronous handler path (retention read +
// 202) and lets the background archive complete before the temp dir is removed.
func TestCreateBackup_Handler(t *testing.T) {
	h, seedName, _ := newBackupTestHandler(t)
	backupDir := filepath.Join(h.dataPath, "backups")
	// Drop the seed backup so the only .tar.gz that appears is the one this
	// handler produces — otherwise the wait below would return immediately.
	if err := os.Remove(filepath.Join(backupDir, seedName)); err != nil {
		t.Fatal(err)
	}
	// A file to archive so the background backup produces a real .tar.gz.
	if err := os.WriteFile(filepath.Join(h.dataPath, "point.db"), []byte("db"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := h.settingsService.SetSetting(context.Background(), "backup_keep", "3", "int"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.CreateBackup(e.NewContext(req, rec)); err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}

	// Wait for the detached goroutine to finish so its writes don't race t.TempDir
	// cleanup, and so the background code path is exercised deterministically.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(backupDir)
		produced := false
		for _, en := range entries {
			if strings.HasSuffix(en.Name(), ".tar.gz") {
				produced = true
			}
		}
		// A finished .tar.gz plus the run guard released means CreateBackup has
		// fully returned; RotateBackups (keep=3, one file) is then a no-op.
		if produced && !h.systemService.BackupRunning() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("background backup did not complete in time")
}
