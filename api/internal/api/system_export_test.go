package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"point-api/internal/models"

	"github.com/labstack/echo/v4"
)

type exportStatus struct {
	Running bool `json:"running"`
	Last    *struct {
		Filename string `json:"filename"`
		Sha256   string `json:"sha256"`
		Error    string `json:"error"`
	} `json:"last"`
}

func getExportStatus(t *testing.T, h *SystemHandler, e *echo.Echo) exportStatus {
	t.Helper()
	rec := httptest.NewRecorder()
	c := e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), rec)
	if err := h.GetExport(c); err != nil {
		t.Fatalf("GetExport: %v", err)
	}
	var st exportStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// TestExport_StartAuthorizeDownload runs the whole flow: start an export, wait
// for the result, authorize the download with the password, and download it.
func TestExport_StartAuthorizeDownload(t *testing.T) {
	h, backupName, _ := newBackupTestHandler(t)
	pw := seedAdmin(t, h)
	e := echo.New()

	if st := getExportStatus(t, h, e); st.Running || st.Last != nil {
		t.Fatalf("status before any export = %+v", st)
	}

	rec := httptest.NewRecorder()
	if err := h.StartExport(e.NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec)); err != nil {
		t.Fatalf("StartExport: %v", err)
	}
	if rec.Code != http.StatusAccepted {
		t.Fatalf("StartExport status = %d, want 202", rec.Code)
	}

	var st exportStatus
	deadline := time.Now().Add(10 * time.Second)
	for {
		st = getExportStatus(t, h, e)
		if !st.Running && st.Last != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("export did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if st.Last.Error != "" || st.Last.Filename == "" {
		t.Fatalf("last export = %+v", st.Last)
	}
	name := st.Last.Filename

	// A backup name is not an export, and a wrong password gets no token.
	if c, _ := newAuthorizeCtx(e, backupName, `{"current_name":"`+pw+`"}`); h.AuthorizeExportDownload(c) == nil {
		t.Fatal("a backup name must not authorize an export download")
	}
	if c, _ := newAuthorizeCtx(e, name, `{"current_name":"wrong"}`); h.AuthorizeExportDownload(c) == nil {
		t.Fatal("wrong password must be rejected")
	}

	c, rec := newAuthorizeCtx(e, name, `{"current_name":"`+pw+`"}`)
	if err := h.AuthorizeExportDownload(c); err != nil {
		t.Fatalf("AuthorizeExportDownload: %v", err)
	}
	var tok map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &tok); err != nil {
		t.Fatal(err)
	}

	download := func(token string) (*httptest.ResponseRecorder, error) {
		rec := httptest.NewRecorder()
		c := e.NewContext(httptest.NewRequest(http.MethodGet, "/?token="+token, nil), rec)
		c.SetParamNames("filename")
		c.SetParamValues(name)
		c.Set("user", models.GetSessionByTokenRow{UserID: 1})
		return rec, h.DownloadExport(c)
	}

	// A backup download token for the same name does not open the export.
	backupTok, err := h.downloadTokens.Issue(1, name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := download(backupTok); err == nil {
		t.Fatal("a backup token must not download an export")
	}

	rec, err = download(tok["token"])
	if err != nil {
		t.Fatalf("DownloadExport: %v", err)
	}
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("download status = %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if got := rec.Header().Get("X-Archive-SHA256"); got != st.Last.Sha256 {
		t.Errorf("X-Archive-SHA256 = %q, want %q", got, st.Last.Sha256)
	}
	// The token is single-use.
	if _, err := download(tok["token"]); err == nil {
		t.Fatal("a used token must not download again")
	}
}
