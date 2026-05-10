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
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
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
	postSvc := services.NewPostService(repo)
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
	pagesH := NewPagesHandler(repo, postSvc, tagSvc, settingsSvc, cacheSvc)

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
		Title: "Hello World",
		Content: "Welcome",
		Status: "published",
		Tags: []string{"News"},
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
	middleware := AuthMiddleware(authSvc)

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
	middleware := OptionalAuthMiddleware(authSvc)

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


