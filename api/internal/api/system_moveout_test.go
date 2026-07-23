package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestRestoreBackup_PasswordGate(t *testing.T) {
	h, _, _ := newBackupTestHandler(t)

	// A valid backup archive (contains point.db) so ScheduleRestore's validation passes.
	name := "backup_valid.tar.gz"
	if err := os.WriteFile(filepath.Join(h.dataPath, "backups", name),
		makeArchive(t, map[string]string{"point.db": "db", "media/a.txt": "hi"}), 0o644); err != nil {
		t.Fatal(err)
	}

	// Seed the account. The "password" is the sha256-hex the client sends; the
	// server stores Argon2id of it.
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

	e := echo.New()
	user := models.GetSessionByTokenRow{UserID: 1}
	marker := filepath.Join(h.dataPath, "backups", "pending_restore")

	newCtx := func(body string) (echo.Context, *httptest.ResponseRecorder) {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("filename")
		c.SetParamValues(name)
		c.Set("user", user)
		return c, rec
	}

	// Wrong password → rejected, nothing scheduled.
	c, _ := newCtx(`{"current_name":"wrong"}`)
	if err := h.RestoreBackup(c); err == nil {
		t.Fatal("wrong password should be rejected")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("no restore should be scheduled on a wrong password")
	}

	// Correct password → restore scheduled.
	c2, _ := newCtx(`{"current_name":"` + pw + `"}`)
	if err := h.RestoreBackup(c2); err != nil {
		t.Fatalf("correct password should succeed: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("restore should have been scheduled: %v", err)
	}
}

// newBackupTestHandler builds a SystemHandler over a temp data dir containing one
// backup file, and returns the handler, the filename, and its contents.
func newBackupTestHandler(t *testing.T) (*SystemHandler, string, []byte) {
	t.Helper()
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	t.Cleanup(func() { _ = repo.Close() })

	backupDir := filepath.Join(tmpDir, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	filename := "backup_20260101_000000.tar.gz"
	content := []byte("ABCDEFGHIJ")
	if err := os.WriteFile(filepath.Join(backupDir, filename), content, 0o644); err != nil {
		t.Fatal(err)
	}

	systemService := services.NewSystemService(repo, tmpDir, "")
	h := NewSystemHandler(repo, nil, nil, services.NewSettingsService(repo), nil, systemService, services.NewCacheService(tmpDir), services.NewAuthService(repo), tmpDir, "1.0.0")
	return h, filename, content
}

func TestDownloadBackup_TokenAndRange(t *testing.T) {
	h, filename, content := newBackupTestHandler(t)
	e := echo.New()
	user := models.GetSessionByTokenRow{UserID: 1}

	token, err := h.downloadTokens.Issue(1, filename)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// A ranged request must stream just the requested bytes (206).
	req := httptest.NewRequest(http.MethodGet, "/api/system/backups/"+filename+"/download?token="+token, nil)
	req.Header.Set("Range", "bytes=0-3")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues(filename)
	c.Set("user", user)

	if err := h.DownloadBackup(c); err != nil {
		t.Fatalf("DownloadBackup: %v", err)
	}
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("range download status = %d, want 206", rec.Code)
	}
	if got := rec.Body.String(); got != string(content[0:4]) {
		t.Fatalf("range body = %q, want %q", got, content[0:4])
	}

	// The token is single-use: a second attempt is rejected.
	req2 := httptest.NewRequest(http.MethodGet, "/api/system/backups/"+filename+"/download?token="+token, nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("filename")
	c2.SetParamValues(filename)
	c2.Set("user", user)
	if err := h.DownloadBackup(c2); err == nil {
		t.Fatal("second use of a consumed token should fail")
	}
}

func TestDownloadBackup_RejectsBadToken(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/api/system/backups/"+filename+"/download?token=nope", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues(filename)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.DownloadBackup(c); err == nil {
		t.Fatal("bad token should be rejected")
	}
}

func TestDownloadBackup_RejectsTokenFromAnotherUser(t *testing.T) {
	h, filename, _ := newBackupTestHandler(t)
	e := echo.New()

	// Token issued to user 2, presented by user 1.
	token, _ := h.downloadTokens.Issue(2, filename)
	req := httptest.NewRequest(http.MethodGet, "/api/system/backups/"+filename+"/download?token="+token, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues(filename)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.DownloadBackup(c); err == nil {
		t.Fatal("token bound to another user should be rejected")
	}
}
