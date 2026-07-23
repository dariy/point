package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

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
