package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestPostHandler_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postService := services.NewPostService(repo)
	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	mediaService := services.NewMediaService(repo, nil, settingsService, tagService)
	handler := NewPostHandler(postService, settingsService, mediaService, tagService)

	e := echo.New()

	// Create user for author
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username:     "author",
		Email:        "a@e.com",
		PasswordHash: "h",
		DisplayName:  "A",
	})

	// Test Create
	reqBody, _ := json.Marshal(CreatePostRequest{
		Title:   "Post1",
		Content: "Content",
		Status:  "published",
	})
	req := httptest.NewRequest(http.MethodPost, "/posts", bytes.NewReader(reqBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	
	// Mock authenticated user session
	session := models.GetSessionByTokenRow{
		UserID:   user.ID,
		Username: user.Username,
	}
	c.Set("user", session)

	if err := handler.CreatePost(c); err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("expected status 201, got %d", rec.Code)
	}

	var created map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	postID := int64(created["id"].(float64))

	// Test Get
	req = httptest.NewRequest(http.MethodGet, "/posts/1", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	c.Set("user", session)

	if err := handler.GetPostByID(c); err != nil {
		t.Fatalf("GetPostByID failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test List (IncludeDrafts=true because user is set)
	req = httptest.NewRequest(http.MethodGet, "/posts", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)

	if err := handler.ListPosts(c); err != nil {
		t.Fatalf("ListPosts failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test Delete
	req = httptest.NewRequest(http.MethodDelete, "/posts/1", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(postID, 10))
	c.Set("user", session)

	if err := handler.DeletePost(c); err != nil {
		t.Fatalf("DeletePost failed: %v", err)
	}
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected status 204, got %d", rec.Code)
	}
}

func TestPostHandler_UpdatePostTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "posts-tags-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	postSvc := services.NewPostService(repo)
	handler := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	ctx := context.Background()
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "tagger", Email: "tagger@test.com", PasswordHash: "h", DisplayName: "Tagger",
	})
	post, _ := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Tag Me", Content: "content", Status: "published", AuthorID: user.ID,
	})
	session := models.GetSessionByTokenRow{UserID: user.ID}

	// Update tags
	body, _ := json.Marshal(map[string]interface{}{"tags": []string{"NewTag", "Another"}})
	req := httptest.NewRequest(http.MethodPut, "/posts/1/tags", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))
	c.Set("user", session)

	if err := handler.UpdatePostTags(c); err != nil {
		t.Fatalf("UpdatePostTags failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid post ID
	req = httptest.NewRequest(http.MethodPut, "/posts/abc/tags", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	c.Set("user", session)
	err := handler.UpdatePostTags(c)
	if err == nil {
		t.Error("expected error for invalid ID")
	}
}

func TestPostHandler_GetPostNavigation(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "posts-nav-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	postSvc := services.NewPostService(repo)
	handler := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	ctx := context.Background()
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "navuser", Email: "nav@test.com", PasswordHash: "h", DisplayName: "Nav",
	})
	post, _ := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Nav Post", Content: "content", Status: "published", AuthorID: user.ID,
	})
	_, _ = postSvc.PublishPost(ctx, post.ID)

	// Valid navigation request
	req := httptest.NewRequest(http.MethodGet, "/posts/1/navigation", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))

	if err := handler.GetPostNavigation(c); err != nil {
		t.Fatalf("GetPostNavigation failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid ID
	req = httptest.NewRequest(http.MethodGet, "/posts/abc/navigation", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	err := handler.GetPostNavigation(c)
	if err == nil {
		t.Error("expected error for invalid ID")
	}
}

func TestPostHandler_GetPostByID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postSvc := services.NewPostService(repo)
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	handler := NewPostHandler(postSvc, settingsSvc, nil, tagSvc)
	e := echo.New()

	// Invalid ID
	req := httptest.NewRequest(http.MethodGet, "/posts/abc", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	if handler.GetPostByID(c) == nil {
		t.Error("expected error for invalid id")
	}

	// Not found
	req = httptest.NewRequest(http.MethodGet, "/posts/99999", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("99999")
	if handler.GetPostByID(c) == nil {
		t.Error("expected error for nonexistent post")
	}

	// Found — published post
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "gbid", Email: "gbid@test.com", PasswordHash: "h", DisplayName: "G",
	})
	post, _ := postSvc.CreatePost(context.Background(), services.CreatePostParams{
		Title: "ID Post", Content: "C", Status: "published", AuthorID: user.ID,
	})
	req = httptest.NewRequest(http.MethodGet, "/posts/1", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))
	if err := handler.GetPostByID(c); err != nil {
		t.Fatalf("GetPostByID failed: %v", err)
	}
}

func TestPostHandler_GeneratePreviewLink(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postSvc := services.NewPostService(repo)
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	handler := NewPostHandler(postSvc, settingsSvc, nil, tagSvc)
	e := echo.New()

	// Invalid ID
	req := httptest.NewRequest(http.MethodPost, "/posts/abc/preview", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	if handler.GeneratePreviewLink(c) == nil {
		t.Error("expected error for invalid id")
	}

	// Valid post
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "prev", Email: "prev@test.com", PasswordHash: "h", DisplayName: "P",
	})
	post, _ := postSvc.CreatePost(context.Background(), services.CreatePostParams{
		Title: "Preview Post", Content: "C", Status: "draft", AuthorID: user.ID,
	})
	req = httptest.NewRequest(http.MethodPost, "/posts/preview", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))
	if err := handler.GeneratePreviewLink(c); err != nil {
		t.Fatalf("GeneratePreviewLink failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestPostHandler_UpdateSettings(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	settingsSvc := services.NewSettingsService(repo)
	handler := NewSettingsHandler(settingsSvc)
	e := echo.New()

	// UpdateSettings
	body, _ := json.Marshal(map[string]string{"blog_title": "My Blog"})
	req := httptest.NewRequest(http.MethodPut, "/settings", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := handler.UpdateSettings(c); err != nil {
		t.Fatalf("UpdateSettings failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}
