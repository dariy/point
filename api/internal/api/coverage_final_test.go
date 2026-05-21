package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
)

// ============================================================
// setup.go - bind error, hash error, seed error
// ============================================================

func TestSetup_BindError(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{notjson}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	err := sh.Setup(e.NewContext(req, rec))
	if err != nil {
		t.Fatalf("unexpected handler error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestSetup_InvalidPasswordFormat(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	body := `{"username":"u","name":"tooshort","blog_title":"T","author_name":"A"}`
	c, rec := echoCtx(http.MethodPost, "/", body)
	if err := sh.Setup(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid password format, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSetup_SeedSettingsError(t *testing.T) {
	h := setupHandlers(t)
	_, _ = h.repo.DB().Exec(`DROP TABLE blog_settings`)
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	body := `{"username":"seeduser","name":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","blog_title":"T","author_name":"A"}`
	c, rec := echoCtx(http.MethodPost, "/", body)
	if err := sh.Setup(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for seed error, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ============================================================
// feeds.go - Sitemap GetPublicTagsForSitemap error
// ============================================================

func TestFeedsHandler_Sitemap_TagRelationsError(t *testing.T) {
	h := setupHandlers(t)
	_, _ = h.repo.DB().Exec(`DROP TABLE tag_relationships`)
	cacheSvc := services.NewCacheService(t.TempDir())
	sh := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, cacheSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/sitemap.xml", nil)
	rec := httptest.NewRecorder()
	err := sh.Sitemap(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error when tag_relationships is dropped")
	}
}

// ============================================================
// tags.go - DB error paths (close DB before handlers)
// ============================================================

func setupTagHandlerClosed(t *testing.T) (*TagHandler, *testHandlers) {
	h := setupHandlers(t)
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	_ = h.repo.Close()
	return th, h
}

func TestTagHandler_GetTagCloud_DBError(t *testing.T) {
	th, _ := setupTagHandlerClosed(t)
	c, _ := echoCtx(http.MethodGet, "/", "")
	err := th.GetTagCloud(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestTagHandler_GetTagByID_DBError(t *testing.T) {
	th, _ := setupTagHandlerClosed(t)
	c, _ := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("id")
	c.SetParamValues("1")
	_ = th.GetTagByID(c)
}

func TestTagHandler_GetTagBySlug_DBError(t *testing.T) {
	th, _ := setupTagHandlerClosed(t)
	c, _ := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("slug")
	c.SetParamValues("sometag")
	_ = th.GetTagBySlug(c)
}

// Tags effectively hidden - public user sees 404 for hidden tag.
// System tags (slug starts with _) must be inserted directly via SQL.
func insertHiddenSystemTag(h *testHandlers) int64 {
	var id int64
	_ = h.repo.DB().QueryRow(
		`INSERT INTO tags (name, slug, post_count, created_at) VALUES ('_hidden','_hidden',0,datetime('now')) RETURNING id`,
	).Scan(&id)
	return id
}

func TestTagHandler_GetTagByID_EffectivelyHidden(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)

	hiddenID := insertHiddenSystemTag(h)
	child, _ := h.tagSvc.CreateTag(nil_ctx(), services.CreateTagParams{Name: "Secret", Slug: "secret-hidden"})
	_, _ = h.repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (?,?)`, hiddenID, child.ID)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strings.Trim(mustJSON(child.ID), "\""))
	err := th.GetTagByID(c)
	if err == nil {
		t.Error("expected 404 for effectively hidden tag (public)")
	}
}

func TestTagHandler_GetTagBySlug_EffectivelyHidden(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)

	hiddenID := insertHiddenSystemTag(h)
	child, _ := h.tagSvc.CreateTag(nil_ctx(), services.CreateTagParams{Name: "Secret2", Slug: "secret2-hidden"})
	_, _ = h.repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (?,?)`, hiddenID, child.ID)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("secret2-hidden")
	err := th.GetTagBySlug(c)
	if err == nil {
		t.Error("expected 404 for hidden tag by slug (public)")
	}
}

func TestTagHandler_GetTagBySlug_AdminInjectHidden(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)

	tag, _ := h.tagSvc.CreateTag(nil_ctx(), services.CreateTagParams{Name: "AdminTag", Slug: "admintag"})

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", "admin")
	c.SetParamNames("slug")
	c.SetParamValues(tag.Slug)
	err := th.GetTagBySlug(c)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestTagHandler_UpdateTag_BindError(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	tag, _ := h.tagSvc.CreateTag(nil_ctx(), services.CreateTagParams{Name: "Bindme", Slug: "bindme"})

	e := echo.New()
	req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader("{notjson}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strings.Trim(mustJSON(tag.ID), "\""))
	err := th.UpdateTag(c)
	if err == nil {
		t.Error("expected error for bind failure")
	}
}

func TestTagHandler_ReorderTag_DBError(t *testing.T) {
	th, _ := setupTagHandlerClosed(t)
	c, _ := echoCtx(http.MethodPut, "/", `{"position":"before"}`)
	c.SetParamNames("id")
	c.SetParamValues("1")
	_ = th.ReorderTag(c)
}

func TestTagHandler_RecalculateCounts_DBError(t *testing.T) {
	th, _ := setupTagHandlerClosed(t)
	c, _ := echoCtx(http.MethodPost, "/", "")
	err := th.RecalculateCounts(c)
	if err == nil {
		t.Error("expected error")
	}
}

// ============================================================
// system.go - GetLogs with many lines
// ============================================================

func TestSystemHandler_GetLogs_ManyLines(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	dataDir := t.TempDir()
	logsDir := filepath.Join(dataDir, "logs")
	_ = os.MkdirAll(logsDir, 0755)
	logLines := strings.Repeat("log line entry\n", 150)
	_ = os.WriteFile(filepath.Join(logsDir, "app.log"), []byte(logLines), 0644)

	systemSvc := services.NewSystemService(h.repo, dataDir)
	cacheSvc := services.NewCacheService(dataDir)
	sh := NewSystemHandler(h.repo, h.mediaSvc, h.postSvc, h.settingsSvc, h.tagSvc, systemSvc, cacheSvc, dataDir, "1.0")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?lines=50", nil)
	rec := httptest.NewRecorder()
	err := sh.GetLogs(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ============================================================
// posts.go - CreatePost bind error, slug conflict
// ============================================================

func TestPostHandler_CreatePost_BindError(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{notjson}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", "admin")
	err := ph.CreatePost(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_CreatePost_SlugConflict(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	// Insert user first so FK constraint is satisfied
	userID := insertUser(h.repo)
	_, _, err := h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "First", Slug: "conflict-slug", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	if err != nil {
		t.Fatalf("failed to create first post: %v", err)
	}
	body := `{"title":"Second","slug":"conflict-slug","status":"draft"}`
	c, rec := echoCtx(http.MethodPost, "/", body)
	c.Set("user", "admin")
	if err := ph.CreatePost(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409 conflict, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestPostHandler_UpdatePost_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	_ = h.repo.Close()
	c, _ := echoCtx(http.MethodPut, "/", `{"title":"Updated"}`)
	c.SetParamNames("id")
	c.SetParamValues("1")
	c.Set("user", "admin")
	_ = ph.UpdatePost(c)
}

func TestPostHandler_CreateAudioPost_NoFile(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Content-Type", "multipart/form-data; boundary=--boundary")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", "admin")
	err := ph.CreateAudioPost(c)
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestPostHandler_CreateAudioPost_UploadError(t *testing.T) {
	ph, h := setupPostHandler(t)
	_ = h.repo.Close()

	boundary := "testboundary"
	body := "--" + boundary + "\r\n" +
		"Content-Disposition: form-data; name=\"file\"; filename=\"test.mp3\"\r\n" +
		"Content-Type: audio/mpeg\r\n\r\n" +
		"fake audio data\r\n" +
		"--" + boundary + "--\r\n"

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", "admin")
	err := ph.CreateAudioPost(c)
	if err == nil {
		t.Error("expected error from UploadFile with closed DB")
	}
}

func TestPostHandler_GetPostNavigation_DBError2(t *testing.T) {
	ph, h := setupPostHandler(t)
	_ = h.repo.Close()
	c, _ := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := ph.GetPostNavigation(c)
	if err == nil {
		t.Error("expected error")
	}
}

// ============================================================
// pages.go - GetHomePage error and per_page paths, GetTagPage
// ============================================================

func TestPagesHandler_GetHomePage_DBError(t *testing.T) {
	ph, h := setupPagesHandler(t)
	_ = h.repo.Close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := ph.GetHomePage(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error with closed DB")
	}
}

func TestPagesHandler_GetHomePage_PerPageQueryParam(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	// Insert invalid posts_per_page → perPage=0 → hits `if perPage < 1` path
	_, _ = h.repo.DB().Exec(`INSERT INTO blog_settings (key, value, value_type) VALUES ('posts_per_page', '0', 'integer')`)
	e := echo.New()
	// Also pass ?per_page=5 → hits `if qpp > 0 { perPage = qpp }` path
	req := httptest.NewRequest(http.MethodGet, "/?per_page=5", nil)
	rec := httptest.NewRecorder()
	err := ph.GetHomePage(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestPagesHandler_GetTagPage_PerPageQueryParam(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	tag, _ := h.tagSvc.CreateTag(nil_ctx(), services.CreateTagParams{Name: "TestNav", Slug: "testnav"})
	_, _ = h.repo.DB().Exec(`INSERT INTO blog_settings (key, value, value_type) VALUES ('posts_per_page', '0', 'integer')`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?per_page=5", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues(tag.Slug)
	err := ph.GetTagPage(c)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestPagesHandler_GetTagPage_PostsTableError(t *testing.T) {
	ph, h := setupPagesHandler(t)
	tag, _ := h.tagSvc.CreateTag(nil_ctx(), services.CreateTagParams{Name: "DropTest", Slug: "droptest"})
	// Drop post_tags so GetPostsByTag fails while tags/slug lookup still works
	_, _ = h.repo.DB().Exec(`DROP TABLE post_tags`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues(tag.Slug)
	err := ph.GetTagPage(c)
	if err == nil {
		t.Error("expected error when post_tags is dropped")
	}
}

// ============================================================
// offline.go - non-image media for GetOfflineStats loop
// ============================================================

func TestOfflineStats_NonImageMedia(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	_, _ = h.repo.DB().Exec(`
		INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum, is_public, uploaded_at)
		VALUES ('test.mp4', 'originals/test.mp4', 'video', 'video/mp4', 1024, 'abc123checksumvideo', 0, datetime('now'))
	`)
	tempDir := t.TempDir()
	systemSvc := services.NewSystemService(h.repo, tempDir)
	cacheSvc := services.NewCacheService(tempDir)
	sh := NewSystemHandler(h.repo, h.mediaSvc, h.postSvc, h.settingsSvc, h.tagSvc, systemSvc, cacheSvc, tempDir, "1.0")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := sh.GetOfflineStats(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ============================================================
// util.go - ParseMapsCoords branch paths
// ============================================================

func TestParseMapsCoords_NotAllowedHost(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?q=https://maps.facebook.com/test", nil)
	rec := httptest.NewRecorder()
	err := ParseMapsCoords(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error for disallowed host")
	}
}

func TestParseMapsCoords_InvalidURL(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?q=http://", nil)
	rec := httptest.NewRecorder()
	err := ParseMapsCoords(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error for invalid URL (empty host)")
	}
}

func TestParseMapsCoords_UnrecognisedInput(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?q=not+a+maps+url+or+degree+string", nil)
	rec := httptest.NewRecorder()
	err := ParseMapsCoords(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error for unrecognised input")
	}
}

// ============================================================
// setup.go - SetupStatus with user, Setup success
// ============================================================

func TestSetupStatus_UserExists(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	c, rec := echoCtx(http.MethodGet, "/setup/status", "")
	if err := sh.SetupStatus(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "true") {
		t.Error("expected setup_complete: true")
	}
}

func TestSetup_Success(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	body := `{"username":"newuser","name":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","blog_title":"My Blog","author_name":"Author"}`
	c, rec := echoCtx(http.MethodPost, "/setup", body)
	if err := sh.Setup(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ============================================================
// posts.go - ListPosts empty DB, CreatePost no status, bad IDs
// ============================================================

func TestListPosts_EmptyDB(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	c, rec := echoCtx(http.MethodGet, "/posts", "")
	if err := ph.ListPosts(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestCreatePost_NoStatus(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	insertUser(h.repo)
	// Omit "status" field → hits posts.go:318 req.Status = "draft"
	body := `{"title":"NoStatusPost","slug":"no-status-post","formatter":"markdown"}`
	c, _ := echoCtx(http.MethodPost, "/posts", body)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := ph.CreatePost(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPublishPost_BadID(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	c, _ := echoCtx(http.MethodPost, "/", "")
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	err := ph.PublishPost(c)
	if err == nil {
		t.Error("expected error for bad id")
	}
}

func TestGeneratePreviewLink_BadID(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	c, _ := echoCtx(http.MethodPost, "/", "")
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	err := ph.GeneratePreviewLink(c)
	if err == nil {
		t.Error("expected error for bad id")
	}
}

func TestWithdrawPost_BadID(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	c, _ := echoCtx(http.MethodPost, "/", "")
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	err := ph.WithdrawPost(c)
	if err == nil {
		t.Error("expected error for bad id")
	}
}

func TestGetPostPage_DraftSlug(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Draft Post", Slug: "draft-post-page", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	c, _ := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("slug")
	c.SetParamValues("draft-post-page")
	err := ph.GetPostPage(c)
	if err == nil {
		t.Error("expected error (404) for draft post slug in GetPostPage")
	}
}

func TestGetPostNavigation_WithNeighbors(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	for _, st := range []struct{ slug, title string }{
		{"nav-first", "First"},
		{"nav-middle", "Middle"},
		{"nav-last", "Last"},
	} {
		_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
			Title: st.title, Slug: st.slug, Status: "draft", Formatter: "markdown", AuthorID: userID,
		})
	}
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('2024-01-01') WHERE slug='nav-first'`)
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('2024-02-01') WHERE slug='nav-middle'`)
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('2024-03-01') WHERE slug='nav-last'`)
	var midID int64
	_ = h.repo.DB().QueryRow(`SELECT id FROM posts WHERE slug='nav-middle'`).Scan(&midID)
	c, rec := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(midID, 10))
	if err := ph.GetPostNavigation(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestGetPostBySlug_Published_NoAuth(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Public Post", Slug: "public-slug-test", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('now') WHERE slug='public-slug-test'`)
	c, rec := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("slug")
	c.SetParamValues("public-slug-test")
	if err := ph.GetPostBySlug(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// ============================================================
// tags.go - GeocodeTag bad id
// ============================================================

func TestGeocodeTag_BadID(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	c, _ := echoCtx(http.MethodPost, "/", `{"lat":1.0,"lng":2.0}`)
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	err := th.GeocodeTag(c)
	if err == nil {
		t.Error("expected error for bad id")
	}
}

// ============================================================
// pages.go - GetTagsPage DB error, admin home, min-tag, hidden
// ============================================================

func TestGetTagsPage_DBError(t *testing.T) {
	ph, h := setupPagesHandler(t)
	_, _ = h.repo.DB().Exec(`DROP TABLE tags`)
	c, _ := echoCtx(http.MethodGet, "/", "")
	err := ph.GetTagsPage(c)
	if err == nil {
		t.Error("expected error when tags table is dropped")
	}
}

func TestGetHomePage_AdminWithPost(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Admin Post", Slug: "admin-home-post", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('now') WHERE slug='admin-home-post'`)
	c, rec := echoCtx(http.MethodGet, "/", "")
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := ph.GetHomePage(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestGetHomePage_MinTagPosts(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	_ = h.settingsSvc.SetSetting(nil_ctx(), "min_tag_posts_to_show", "3", "integer")
	c, rec := echoCtx(http.MethodGet, "/", "")
	if err := ph.GetHomePage(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// insertHidePostsSystemTag inserts the _hide_posts system tag and a direct child tag via raw SQL,
// returning the child tag ID. Posts tagged with the child are hidden from public view (the set is
// seeded from direct children of _hide_posts, not the system tag itself).
func insertHidePostsSystemTag(h *testHandlers) int64 {
	var sysID int64
	_ = h.repo.DB().QueryRow(
		`INSERT INTO tags (name, slug, post_count, created_at) VALUES ('_hide_posts','_hide_posts',0,datetime('now')) RETURNING id`,
	).Scan(&sysID)
	var childID int64
	_ = h.repo.DB().QueryRow(
		`INSERT INTO tags (name, slug, post_count, created_at) VALUES ('HidePosts','hide-posts-child',0,datetime('now')) RETURNING id`,
	).Scan(&childID)
	_, _ = h.repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (?,?)`, sysID, childID)
	return childID
}

func TestGetHomePage_HiddenPostFiltered(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	hideTagID := insertHidePostsSystemTag(h)
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Hidden Home Post", Slug: "hidden-home-post", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	var postID int64
	_ = h.repo.DB().QueryRow(`SELECT id FROM posts WHERE slug='hidden-home-post'`).Scan(&postID)
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?`, postID)
	_, _ = h.repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, postID, hideTagID)
	c, rec := echoCtx(http.MethodGet, "/", "")
	if err := ph.GetHomePage(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestGetTagPage_HiddenPostFiltered(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	hideTagID := insertHidePostsSystemTag(h)
	tag, _ := h.tagSvc.CreateTag(nil_ctx(), services.CreateTagParams{Name: "VisibleTag", Slug: "visible-tag-filter"})
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Hidden Tag Post", Slug: "hidden-tag-post-filter", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	var postID int64
	_ = h.repo.DB().QueryRow(`SELECT id FROM posts WHERE slug='hidden-tag-post-filter'`).Scan(&postID)
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?`, postID)
	_, _ = h.repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, postID, hideTagID)
	_, _ = h.repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, postID, tag.ID)
	c, rec := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("slug")
	c.SetParamValues(tag.Slug)
	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestGetPostBySlug_HiddenPostsTag(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	hideTagID := insertHidePostsSystemTag(h)
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Hidden Slug Post", Slug: "hidden-slug-post", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	var postID int64
	_ = h.repo.DB().QueryRow(`SELECT id FROM posts WHERE slug='hidden-slug-post'`).Scan(&postID)
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?`, postID)
	_, _ = h.repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, postID, hideTagID)
	c, _ := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("slug")
	c.SetParamValues("hidden-slug-post")
	err := ph.GetPostBySlug(c)
	if err == nil {
		t.Error("expected 404 for post with _hide_posts tag (public user)")
	}
}

func TestGetPostByID_HiddenPostsTag(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	hideTagID := insertHidePostsSystemTag(h)
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Hidden ID Post", Slug: "hidden-id-post", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	var postID int64
	_ = h.repo.DB().QueryRow(`SELECT id FROM posts WHERE slug='hidden-id-post'`).Scan(&postID)
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?`, postID)
	_, _ = h.repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, postID, hideTagID)
	c, _ := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(postID, 10))
	err := ph.GetPostByID(c)
	if err == nil {
		t.Error("expected 404 for post with _hide_posts tag (public user)")
	}
}

// ============================================================
// offline.go - thumbnail file exists on disk
// ============================================================

func TestOfflineStats_WithThumbnail(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	dataDir := t.TempDir()
	// offline.go builds the path as filepath.Join(h.dataPath, "media", m.ThumbnailPath.String)
	thumbDir := filepath.Join(dataDir, "media", "thumbnails")
	_ = os.MkdirAll(thumbDir, 0755)
	_ = os.WriteFile(filepath.Join(thumbDir, "test_thumb.jpg"), []byte("fake thumbnail data"), 0644)
	_, _ = h.repo.DB().Exec(`
		INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum, is_public, thumbnail_path, uploaded_at)
		VALUES ('test.jpg', 'originals/test.jpg', 'image', 'image/jpeg', 2048, 'abc123thumbnail', 1, 'thumbnails/test_thumb.jpg', datetime('now'))
	`)
	systemSvc := services.NewSystemService(h.repo, dataDir)
	cacheSvc := services.NewCacheService(dataDir)
	sh := NewSystemHandler(h.repo, h.mediaSvc, h.postSvc, h.settingsSvc, h.tagSvc, systemSvc, cacheSvc, dataDir, "1.0")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := sh.GetOfflineStats(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

// ============================================================
// setup.go - SetupStatus false path (no user)
// ============================================================

func TestSetupStatus_NoUser(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	c, rec := echoCtx(http.MethodGet, "/setup/status", "")
	if err := sh.SetupStatus(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "false") {
		t.Errorf("expected setup_complete: false, got: %s", rec.Body.String())
	}
}

// ============================================================
// posts.go - GetPostBySlug as admin injects hidden fields
// ============================================================

func TestGetPostBySlug_Admin(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	userID := insertUser(h.repo)
	_, _, _ = h.postSvc.CreatePost(nil_ctx(), services.CreatePostParams{
		Title: "Admin View Post", Slug: "admin-view-post", Status: "draft", Formatter: "markdown", AuthorID: userID,
	})
	_, _ = h.repo.DB().Exec(`UPDATE posts SET status='published', published_at=datetime('now') WHERE slug='admin-view-post'`)
	c, rec := echoCtx(http.MethodGet, "/", "")
	c.SetParamNames("slug")
	c.SetParamValues("admin-view-post")
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := ph.GetPostBySlug(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}
