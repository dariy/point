package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestListBackups_ReportsInProgress(t *testing.T) {
	// newBackupTestHandler seeds one finished backup; add an in-progress partial.
	h, finished, _ := newBackupTestHandler(t)
	backupDir := filepath.Join(h.dataPath, "backups")
	if err := os.WriteFile(filepath.Join(backupDir, "backup_running.tar.gz.partial"), []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/backups", nil)
	rec := httptest.NewRecorder()
	if err := h.ListBackups(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListBackups: %v", err)
	}

	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}

	var sawInProgress, sawFinished bool
	for _, b := range list {
		switch b["filename"] {
		case "backup_running.tar.gz":
			if b["in_progress"] == true {
				sawInProgress = true
			}
		case finished:
			// A finished backup must not be flagged in-progress.
			if b["in_progress"] == nil {
				sawFinished = true
			}
		}
	}
	if !sawInProgress {
		t.Errorf("expected an in_progress entry with the .partial suffix trimmed; got %v", list)
	}
	if !sawFinished {
		t.Errorf("expected the finished backup listed as complete; got %v", list)
	}
}
