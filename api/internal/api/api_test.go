package api

import (
	"bytes"
	"context"
	"encoding/json"
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
	"point-api/internal/repository"
	"point-api/internal/services"
)

func setupTestDB(t *testing.T) *repository.Repository {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	schema, err := os.ReadFile("../../sql/schema.sql")
	if err != nil {
		t.Fatalf("failed to read schema: %v", err)
	}

	_, err = repo.DB().Exec(string(schema))
	if err != nil {
		t.Fatalf("failed to execute schema: %v", err)
	}

	return repo
}

func TestFullWorkflow(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "api-full-test")
	defer os.RemoveAll(tmpDir)

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
	authH := NewAuthHandler(authSvc, cfg)
	mediaH := NewMediaHandler(mediaSvc, settingsSvc)
	postH := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	tagH := NewTagHandler(tagSvc, settingsSvc)
	systemH := NewSystemHandler(repo, mediaSvc, settingsSvc, tagSvc, tmpDir)
	pagesH := NewPagesHandler(repo, postSvc, tagSvc, settingsSvc)

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
	authH.Login(c)
	
	session := models.GetSessionByTokenRow{UserID: user.ID, Username: user.Username}

	// 3. Create Tag
	tagBody, _ := json.Marshal(CreateTagRequest{Name: "News"})
	req = httptest.NewRequest(http.MethodPost, "/tags", bytes.NewReader(tagBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	tagH.CreateTag(c)

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
	postH.CreatePost(c)

	// 5. Homepage
	rec = httptest.NewRecorder()
	pagesH.GetHomePage(e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), rec))

	// 6. Media upload
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var imgBuf bytes.Buffer
	png.Encode(&imgBuf, img)
	
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	p, _ := writer.CreateFormFile("file", "image.png")
	p.Write(imgBuf.Bytes())
	writer.Close()
	req = httptest.NewRequest(http.MethodPost, "/media/upload", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	mediaH.UploadFile(c)

	// 7. System operations
	rec = httptest.NewRecorder()
	systemH.GetStats(e.NewContext(httptest.NewRequest(http.MethodGet, "/stats", nil), rec))
	rec = httptest.NewRecorder()
	systemH.ClearCache(e.NewContext(httptest.NewRequest(http.MethodPost, "/cache/clear", nil), rec))
	
	// Backup
	rec = httptest.NewRecorder()
	systemH.CreateBackup(e.NewContext(httptest.NewRequest(http.MethodPost, "/system/backup", nil), rec))
	var backupResp map[string]interface{}
	json.Unmarshal(rec.Body.Bytes(), &backupResp)
	if backupResp != nil && backupResp["filename"] != nil {
		backupFile := backupResp["filename"].(string)

		// List backups
		rec = httptest.NewRecorder()
		systemH.ListBackups(e.NewContext(httptest.NewRequest(http.MethodGet, "/system/backups", nil), rec))

		// Delete backup
		rec = httptest.NewRecorder()
		c = e.NewContext(httptest.NewRequest(http.MethodDelete, "/system/backups/"+backupFile, nil), rec)
		c.SetParamNames("filename")
		c.SetParamValues(backupFile)
		systemH.DeleteBackup(c)

		// Create another backup to test restore
		rec = httptest.NewRecorder()
		systemH.CreateBackup(e.NewContext(httptest.NewRequest(http.MethodPost, "/system/backup", nil), rec))
		json.Unmarshal(rec.Body.Bytes(), &backupResp)
		backupFile2 := backupResp["filename"].(string)

		rec = httptest.NewRecorder()
		c = e.NewContext(httptest.NewRequest(http.MethodPost, "/system/restore/"+backupFile2, nil), rec)
		c.SetParamNames("filename")
		c.SetParamValues(backupFile2)
		systemH.RestoreBackup(c)
	}

	// 8. Error paths
	// Login with wrong password
	badLogin, _ := json.Marshal(LoginRequest{Username: "admin", Password: "wrong"})
	req = httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(badLogin))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	authH.Login(e.NewContext(req, rec))

	// Create tag with invalid JSON
	req = httptest.NewRequest(http.MethodPost, "/tags", bytes.NewReader([]byte("{invalid}")))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	tagH.CreateTag(e.NewContext(req, rec))

	// Get non-existent post
	req = httptest.NewRequest(http.MethodGet, "/posts/999", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("999")
	postH.GetPostByID(c)

	// 9. Post lifecycle
	// Get by slug
	req = httptest.NewRequest(http.MethodGet, "/posts/slug/hello-world", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("hello-world")
	postH.GetPostBySlug(c)

	// Publish
	req = httptest.NewRequest(http.MethodPost, "/posts/1/publish", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	postH.PublishPost(c)

	// Withdraw
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	postH.WithdrawPost(c)

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
	postH.GetPostByPreviewToken(c)

	// Update post
	upPostBody, _ := json.Marshal(UpdatePostRequest{Title: "Updated title", Content: "New content", Status: "published"})
	req = httptest.NewRequest(http.MethodPost, "/posts/1", bytes.NewReader(upPostBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	c.Set("user", session)
	postH.UpdatePost(c)

	// Create audio post
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	p, _ = writer.CreateFormFile("file", "test.mp3")
	p.Write([]byte("fake audio content"))
	writer.WriteField("title", "Audio Post")
	writer.Close()
	req = httptest.NewRequest(http.MethodPost, "/posts/audio", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	postH.CreateAudioPost(c)

	// 9. Tag operations
	tagH.GetTagCloud(e.NewContext(httptest.NewRequest(http.MethodGet, "/tags/cloud", nil), httptest.NewRecorder()))
	tagH.RecalculateCounts(e.NewContext(httptest.NewRequest(http.MethodPost, "/tags/recalculate", nil), httptest.NewRecorder()))
}

func TestAuthMiddleware(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
	expiresAt := time.Now().Add(1 * time.Hour)
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
	defer repo.Close()

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
	expiresAt := time.Now().Add(1 * time.Hour)
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

func TestExtractUserID_Invalid(t *testing.T) {
	if id := extractUserID("invalid"); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
	if id := extractSessionID("invalid"); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
}


