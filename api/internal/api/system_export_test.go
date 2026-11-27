package api

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"

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

type importStatus struct {
	Running bool `json:"running"`
	Empty   bool `json:"empty"`
	Last    *struct {
		Error  string `json:"error"`
		Counts struct {
			Posts int `json:"posts"`
		} `json:"counts"`
	} `json:"last"`
}

func getImportStatus(t *testing.T, h *SystemHandler, e *echo.Echo) importStatus {
	t.Helper()
	rec := httptest.NewRecorder()
	if err := h.GetImport(e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), rec)); err != nil {
		t.Fatalf("GetImport: %v", err)
	}
	var st importStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// importTestArchive is a portable export with one post.
func importTestArchive(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range [][2]string{
		{"manifest.json", `{"format":"point-export","version":1,"instance_version":"v1"}`},
		{"tags.json", `[]`},
		{"posts/hello.md", "---\ntitle: Hello\nslug: hello\ntype: post\nstatus: published\nformatter: markdown\ncreated_at: 2024-01-05T17:00:00Z\nupdated_at: 2024-01-05T17:00:00Z\ntags:\n    - greetings\n---\n\nHi.\n"},
	} {
		if err := tw.WriteHeader(&tar.Header{Name: e[0], Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(e[1]))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestImport_UploadAndStatus uploads an archive with the password, waits for
// the result, and checks that a second import is refused.
func TestImport_UploadAndStatus(t *testing.T) {
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })
	dir := t.TempDir()
	settings := services.NewSettingsService(repo)
	tags := services.NewTagService(repo)
	media := services.NewMediaService(repo, &config.Config{StoragePath: dir}, settings, tags)
	posts := services.NewPostService(repo, settings, nil, tags, "")
	h := NewSystemHandler(repo, media, posts, settings, tags, services.NewSystemService(repo, dir, ""),
		services.NewCacheService(dir), services.NewAuthService(repo), dir, "1.0.0")
	pw := seedAdmin(t, h)
	e := echo.New()

	if st := getImportStatus(t, h, e); st.Running || st.Last != nil || !st.Empty {
		t.Fatalf("status before any import = %+v", st)
	}

	start := func(password string) (*httptest.ResponseRecorder, error) {
		req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(importTestArchive(t)))
		req.Header.Set("X-Confirm-Password", password)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.Set("user", models.GetSessionByTokenRow{UserID: 1})
		return rec, h.StartImport(c)
	}
	if _, err := start("wrong"); err == nil {
		t.Fatal("a wrong password must be rejected")
	}
	rec, err := start(pw)
	if err != nil {
		t.Fatalf("StartImport: %v", err)
	}
	if rec.Code != http.StatusAccepted {
		t.Fatalf("StartImport status = %d, want 202", rec.Code)
	}

	var st importStatus
	deadline := time.Now().Add(10 * time.Second)
	for {
		st = getImportStatus(t, h, e)
		if !st.Running && st.Last != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("import did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if st.Last.Error != "" || st.Last.Counts.Posts != 1 || st.Empty {
		t.Fatalf("status after the import = %+v %+v", st, st.Last)
	}
	if p, err := repo.GetPostBySlug(context.Background(), "hello"); err != nil || p.Title != "Hello" {
		t.Fatalf("imported post = %+v, %v", p, err)
	}

	_, err = start(pw)
	var he *echo.HTTPError
	if !errors.As(err, &he) || he.Code != http.StatusConflict {
		t.Fatalf("second StartImport = %v, want 409", err)
	}
}
