package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestFullWorkflow(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "api-full-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{
		StoragePath:              tmpDir,
		ThumbnailWidth:           100,
		ThumbnailHeight:          100,
		SessionExpiryHours:       720,
		SessionExpiryPublicHours: 24,
	}

	// Services
	settingsSvc := services.NewSettingsService(repo)
	authSvc := services.NewAuthService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)

	// Handlers
	authH := NewAuthHandler(authSvc, cfg, repo)
	mediaH := NewMediaHandler(mediaSvc, settingsSvc)
	postH := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	tagH := NewTagHandler(tagSvc, settingsSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	systemH := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")
	pagesH := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheSvc)

	e := echo.New()
	ctx := context.Background()

	// 1. Create User
	pass := "pass123"
	hash, _ := services.HashPassword(pass)
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "admin",
		Email:        "admin@test.com",
		PasswordHash: hash,
		DisplayName:  "Admin",
	})

	// 2. Login
	loginBody, _ := json.Marshal(LoginRequest{Username: "admin", Password: pass})
	req := httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(loginBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	_ = authH.Login(c)

	session := models.GetSessionByTokenRow{UserID: user.ID, Username: user.Username}

	// 3. Create Tag
	tagBody, _ := json.Marshal(CreateTagRequest{Name: "News"})
	req = httptest.NewRequest(http.MethodPost, "/tags", bytes.NewReader(tagBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	_ = tagH.CreateTag(c)

	// 4. Create Post
	postBody, _ := json.Marshal(CreatePostRequest{
		Title:   "Hello World",
		Content: "Welcome",
		Status:  "published",
		Tags:    []string{"News"},
	})
	req = httptest.NewRequest(http.MethodPost, "/posts", bytes.NewReader(postBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	_ = postH.CreatePost(c)

	// 5. Homepage
	rec = httptest.NewRecorder()
	_ = pagesH.GetHomePage(e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), rec))

	// 6. Media upload
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var imgBuf bytes.Buffer
	_ = png.Encode(&imgBuf, img)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	p, _ := writer.CreateFormFile("file", "image.png")
	_, _ = p.Write(imgBuf.Bytes())
	_ = writer.Close()
	req = httptest.NewRequest(http.MethodPost, "/media/upload", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	_ = mediaH.UploadFile(c)

	// 7. System operations
	rec = httptest.NewRecorder()
	_ = systemH.GetStats(e.NewContext(httptest.NewRequest(http.MethodGet, "/stats", nil), rec))
	rec = httptest.NewRecorder()
	_ = systemH.ClearCache(e.NewContext(httptest.NewRequest(http.MethodPost, "/cache/clear", nil), rec))

	// Backup
	rec = httptest.NewRecorder()
	_ = systemH.CreateBackup(e.NewContext(httptest.NewRequest(http.MethodPost, "/system/backup", nil), rec))
	var backupResp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &backupResp)
	if backupResp != nil && backupResp["filename"] != nil {
		backupFile := backupResp["filename"].(string)

		// List backups
		rec = httptest.NewRecorder()
		_ = systemH.ListBackups(e.NewContext(httptest.NewRequest(http.MethodGet, "/system/backups", nil), rec))

		// Delete backup
		rec = httptest.NewRecorder()
		c = e.NewContext(httptest.NewRequest(http.MethodDelete, "/system/backups/"+backupFile, nil), rec)
		c.SetParamNames("filename")
		c.SetParamValues(backupFile)
		_ = systemH.DeleteBackup(c)

		// Create another backup to test restore
		rec = httptest.NewRecorder()
		_ = systemH.CreateBackup(e.NewContext(httptest.NewRequest(http.MethodPost, "/system/backup", nil), rec))
		_ = json.Unmarshal(rec.Body.Bytes(), &backupResp)
		backupFile2 := backupResp["filename"].(string)

		rec = httptest.NewRecorder()
		c = e.NewContext(httptest.NewRequest(http.MethodPost, "/system/restore/"+backupFile2, nil), rec)
		c.SetParamNames("filename")
		c.SetParamValues(backupFile2)
		_ = systemH.RestoreBackup(c)
	}

	// 8. Error paths
	// Login with wrong password
	badLogin, _ := json.Marshal(LoginRequest{Username: "admin", Password: "wrong"})
	req = httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(badLogin))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	_ = authH.Login(e.NewContext(req, rec))

	// Create tag with invalid JSON
	req = httptest.NewRequest(http.MethodPost, "/tags", bytes.NewReader([]byte("{invalid}")))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	_ = tagH.CreateTag(e.NewContext(req, rec))

	// Get non-existent post
	req = httptest.NewRequest(http.MethodGet, "/posts/999", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("999")
	_ = postH.GetPostByID(c)

	// 9. Post lifecycle
	// Get by slug
	req = httptest.NewRequest(http.MethodGet, "/posts/slug/hello-world", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("hello-world")
	_ = postH.GetPostBySlug(c)

	// Publish
	req = httptest.NewRequest(http.MethodPost, "/posts/1/publish", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	_ = postH.PublishPost(c)

	// Withdraw
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	_ = postH.WithdrawPost(c)

	// Preview link
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	if err := postH.GeneratePreviewLink(c); err != nil {
		t.Fatalf("GeneratePreviewLink failed: %v", err)
	}
	var previewResp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &previewResp); err != nil {
		t.Fatalf("Failed to unmarshal preview response: %v. Body: %s", err, rec.Body.String())
	}

	token, ok := previewResp["token"].(string)
	if !ok {
		t.Fatalf("Token not found in response: %v", previewResp)
	}

	// Get by preview token
	req = httptest.NewRequest(http.MethodGet, "/posts/preview/"+token, nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("token")
	c.SetParamValues(token)
	_ = postH.GetPostByPreviewToken(c)

	// Update post
	upPostBody, _ := json.Marshal(UpdatePostRequest{Title: "Updated title", Content: "New content", Status: "published"})
	req = httptest.NewRequest(http.MethodPost, "/posts/1", bytes.NewReader(upPostBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	c.Set("user", session)
	_ = postH.UpdatePost(c)

	// Create audio post
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	p, _ = writer.CreateFormFile("file", "test.mp3")
	_, _ = p.Write([]byte("fake audio content"))
	_ = writer.WriteField("title", "Audio Post")
	_ = writer.Close()
	req = httptest.NewRequest(http.MethodPost, "/posts/audio", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	_ = postH.CreateAudioPost(c)

	// 9. Tag operations
	_ = tagH.GetTagCloud(e.NewContext(httptest.NewRequest(http.MethodGet, "/tags/cloud", nil), httptest.NewRecorder()))
	_ = tagH.RecalculateCounts(e.NewContext(httptest.NewRequest(http.MethodPost, "/tags/recalculate", nil), httptest.NewRecorder()))
}

func TestAuthMiddleware(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	authSvc := services.NewAuthService(repo)
	apiKeySvc := services.NewApiKeyService(repo)
	middleware := AuthMiddleware(authSvc, apiKeySvc)

	e := echo.New()
	handler := func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	}

	// 1. No cookie
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := middleware(handler)(c)
	if err != nil {
		if he, ok := err.(*echo.HTTPError); ok {
			if he.Code != http.StatusUnauthorized {
				t.Errorf("expected 401, got %d", he.Code)
			}
		}
	}

	// 2. Valid session
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "u1", Email: "u1@t.com", PasswordHash: "h", DisplayName: "U1",
	})
	token := "valid-token"
	expiresAt := time.Now().Add(1 * time.Hour).UTC().Round(0)
	_, _ = authSvc.CreateSession(context.Background(), user.ID, "1.1.1.1", "agent", expiresAt, token)

	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := middleware(handler)(c); err != nil {
		t.Fatalf("Middleware failed with valid session: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 3. Invalid session
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: "invalid-token"})
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	err = middleware(handler)(c)
	if err != nil {
		if he, ok := err.(*echo.HTTPError); ok {
			if he.Code != http.StatusUnauthorized {
				t.Errorf("expected 401 for invalid token, got %d", he.Code)
			}
		}
	}
}

func TestOptionalAuthMiddleware(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	authSvc := services.NewAuthService(repo)
	apiKeySvc := services.NewApiKeyService(repo)
	middleware := OptionalAuthMiddleware(authSvc, apiKeySvc)

	e := echo.New()
	handler := func(c echo.Context) error {
		return c.String(http.StatusOK, "ok")
	}

	// 1. No cookie
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := middleware(handler)(c); err != nil {
		t.Fatalf("Middleware failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 2. Valid session
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "u2", Email: "u2@t.com", PasswordHash: "h", DisplayName: "U2",
	})
	token := "valid-token-opt"
	expiresAt := time.Now().Add(1 * time.Hour).UTC().Round(0)
	_, _ = authSvc.CreateSession(context.Background(), user.ID, "1.1.1.1", "agent", expiresAt, token)

	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := middleware(handler)(c); err != nil {
		t.Fatalf("Middleware failed with valid session: %v", err)
	}
	if c.Get("user") == nil {
		t.Error("user should be set in context")
	}
}

func TestCustomHTTPErrorHandler(t *testing.T) {
	e := echo.New()
	e.HTTPErrorHandler = CustomHTTPErrorHandler

	// 1. Standard HTTP error
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	var err error
	err = echo.NewHTTPError(http.StatusNotFound, "not found test")
	e.HTTPErrorHandler(err, c)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}

	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp["detail"] != "not found test" {
		t.Errorf("expected detail 'not found test', got '%s'", resp["detail"])
	}

	// 2. Generic error
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)

	err = fmt.Errorf("generic error test")
	e.HTTPErrorHandler(err, c)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp["detail"] != "generic error test" {
		t.Errorf("expected detail 'generic error test', got '%s'", resp["detail"])
	}
}

func TestExtractUserID_Invalid(t *testing.T) {
	if id := extractUserID("invalid"); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
	if id := extractSessionID("invalid"); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
}
func nil_ctx() context.Context { return context.Background() }

type testHandlers struct {
	repo        repository.Repository
	settingsSvc *services.SettingsService
	tagSvc      *services.TagService
	postSvc     *services.PostService
	authSvc     *services.AuthService
	mediaSvc    *services.MediaService
	cacheSvc    *services.CacheService
	cfg         *config.Config
}

func setupHandlers(t *testing.T) *testHandlers {
	t.Helper()
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	cfg := &config.Config{
		StoragePath:     tmpDir,
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	authSvc := services.NewAuthService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	cacheSvc := services.NewCacheService(tmpDir)
	return &testHandlers{repo, settingsSvc, tagSvc, postSvc, authSvc, mediaSvc, cacheSvc, cfg}
}

func (h *testHandlers) close() { _ = h.repo.Close() }

func echoCtx(method, target string, body string) (echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	var reqBody *strings.Reader
	if body != "" {
		reqBody = strings.NewReader(body)
	} else {
		reqBody = strings.NewReader("")
	}
	req := httptest.NewRequest(method, target, reqBody)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	return e.NewContext(req, rec), rec
}

func insertUser(repo repository.Repository) int64 {
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	return 1
}

func mustJSON(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}
func TestNavMenuHandler_GetAdminNavMenu_Default(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/nav-menu", nil)
	rec := httptest.NewRecorder()
	if err := h.GetAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetAdminNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["mode"] != "tags" {
		t.Errorf("expected default mode 'tags', got %v", resp["mode"])
	}
}

func TestNavMenuHandler_UpdateAdminNavMenu_Tags(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()

	body := `{"mode":"tags","items":[]}`
	req := httptest.NewRequest(http.MethodPut, "/api/nav-menu", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.UpdateAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateAdminNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["mode"] != "tags" {
		t.Errorf("expected mode 'tags', got %v", resp["mode"])
	}
}

func TestNavMenuHandler_UpdateAdminNavMenu_Custom(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()

	body := `{"mode":"custom","items":[{"id":1,"label":"Home","url":"/"}]}`
	req := httptest.NewRequest(http.MethodPut, "/api/nav-menu", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.UpdateAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateAdminNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/nav-menu", nil)
	rec2 := httptest.NewRecorder()
	_ = h.GetAdminNavMenu(e.NewContext(req2, rec2))
	var resp map[string]interface{}
	_ = json.Unmarshal(rec2.Body.Bytes(), &resp)
	if resp["mode"] != "custom" {
		t.Errorf("expected mode 'custom', got %v", resp["mode"])
	}
}

func TestNavMenuHandler_UpdateAdminNavMenu_InvalidMode(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()

	body := `{"mode":"invalid","items":null}`
	req := httptest.NewRequest(http.MethodPut, "/api/nav-menu", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	_ = h.UpdateAdminNavMenu(e.NewContext(req, rec))
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["mode"] != "tags" {
		t.Errorf("expected fallback mode 'tags', got %v", resp["mode"])
	}
}

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
		t.Error("expected 404 for post with hides_posts tag (public user)")
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
		t.Error("expected 404 for post with hides_posts tag (public user)")
	}
}

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
func setupTestDB(t *testing.T) repository.Repository {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	return repo
}
