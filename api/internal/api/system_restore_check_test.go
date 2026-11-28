package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v5"
)

func TestRestoreCheckEndpoints(t *testing.T) {
	// The seeded backup is ten bytes of text, so the check runs and fails.
	h, filename, _ := newBackupTestHandler(t)
	e := echo.New()

	get := func() map[string]any {
		t.Helper()
		rec := httptest.NewRecorder()
		if err := h.GetRestoreCheck(e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), rec)); err != nil {
			t.Fatalf("GetRestoreCheck: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v (%s)", err, rec.Body.String())
		}
		return body
	}
	if body := get(); body["last"] != nil || body["running"] != false {
		t.Fatalf("before a check: %v, want last=null running=false", body)
	}

	post := func(payload string) (*httptest.ResponseRecorder, error) {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(payload))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		return rec, h.StartRestoreCheck(e.NewContext(req, rec))
	}
	if _, err := post(`{"filename":"../x.tar.gz"}`); err == nil {
		t.Error("StartRestoreCheck with a bad name: want an error")
	}
	rec, err := post(`{}`)
	if err != nil || rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), filename) {
		t.Fatalf("StartRestoreCheck = %d %s (%v), want 202 naming %s", rec.Code, rec.Body.String(), err, filename)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		body := get()
		if last, ok := body["last"].(map[string]any); ok && body["running"] == false {
			if last["passed"] != false || last["backup"] != filename {
				t.Errorf("last = %v, want a fail of %s", last, filename)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the restore check did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// The health block carries the summary.
	rc, ok := h.backupHealth(t.Context())["restore_check"].(map[string]any)
	if !ok || rc["passed"] != false || rc["backup"] != filename {
		t.Errorf("backupHealth restore_check = %v", rc)
	}
}
