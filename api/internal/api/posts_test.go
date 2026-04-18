package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
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

func TestPostHandler_GetPostPage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()
	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)

	// Create author
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "author", Email: "a@e.com", PasswordHash: "h", DisplayName: "A",
	})

	// Create 12 published posts (ordered newest first by published_at)
	// newest (i=12) -> oldest (i=1)
	for i := 1; i <= 12; i++ {
		slug := fmt.Sprintf("post-%d", i)
		post, _ := postSvc.CreatePost(ctx, services.CreatePostParams{
			Title:    fmt.Sprintf("Post %d", i),
			Slug:     slug,
			Status:   "published",
			AuthorID: user.ID,
		})
		// Set published_at: higher i -> newer
		pubAt := time.Date(2024, 1, 1, 10, i, 0, 0, time.UTC).Format("2006-01-02 15:04:05")
		_, _ = repo.DB().Exec(`UPDATE posts SET published_at = ? WHERE id = ?`, pubAt, post.ID)
	}
	// Order newest first: post-12, post-11, ..., post-1
	// Page 1 (10 per page): post-12 ... post-3
	// Page 2: post-2, post-1

	handler := NewPostHandler(postSvc, settingsSvc, nil, tagSvc)
	e := echo.New()

	t.Run("first page post", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues("post-12")

		if err := handler.GetPostPage(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		var resp map[string]interface{}
		_ = json.NewDecoder(rec.Body).Decode(&resp)
		if int(resp["page"].(float64)) != 1 {
			t.Errorf("expected page 1, got %v", resp["page"])
		}
	})

	t.Run("second page post", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues("post-1")

		if err := handler.GetPostPage(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		var resp map[string]interface{}
		_ = json.NewDecoder(rec.Body).Decode(&resp)
		if int(resp["page"].(float64)) != 2 {
			t.Errorf("expected page 2, got %v", resp["page"])
		}
	})

	t.Run("unknown slug returns 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues("no-such-post")

		err := handler.GetPostPage(c)
		if err == nil {
			t.Fatal("expected error for unknown slug")
		}
		he, ok := err.(*echo.HTTPError)
		if !ok || he.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %v", err)
		}
	})

	t.Run("post in tag-context page", func(t *testing.T) {
		// post-1 has tag 'travel'
		// Create tag
		_, _ = tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Travel", Slug: "travel"})
		// Find post-1 ID
		p1, _ := postSvc.GetPostBySlug(ctx, "post-1")
		_ = postSvc.UpdatePostTags(ctx, p1.ID, []string{"Travel"})

		req := httptest.NewRequest(http.MethodGet, "/?tag=travel", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues("post-1")

		if err := handler.GetPostPage(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		var resp map[string]interface{}
		_ = json.NewDecoder(rec.Body).Decode(&resp)
		// Only one post has 'travel' tag, so it should be on page 1
		if int(resp["page"].(float64)) != 1 {
			t.Errorf("expected page 1 for tag travel, got %v", resp["page"])
		}
	})
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

func TestFetchAncestorsMapDirect(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'A','a'),(2,'B','b')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	postTagsMap := map[int64][]repository.PostTagInfo{
		1: {{ID: 2, Name: "B", Slug: "b"}},
	}
	result := fetchAncestorsMap(ctx, repo, postTagsMap)
	if len(result) == 0 {
		t.Error("expected non-empty ancestors map")
	}
}

func TestExpandPostTagsWithAncestors(t *testing.T) {
	postTagsMap := map[int64][]repository.PostTagInfo{
		1: {
			{ID: 2, Name: "Child", Slug: "child"},
			{ID: 2, Name: "Child", Slug: "child"},
		},
		2: {
			{ID: 10, Name: "_system", Slug: "_system"},
		},
	}
	ancestorsMap := map[int64][]repository.PostTagInfo{
		2: {{ID: 3, Name: "Parent", Slug: "parent"}},
	}

	result := expandPostTagsWithAncestors(postTagsMap, ancestorsMap, false)
	if len(result[1]) == 0 {
		t.Error("expected tags for post 1")
	}

	result2 := expandPostTagsWithAncestors(postTagsMap, ancestorsMap, true)
	for _, tag := range result2[2] {
		if strings.HasPrefix(tag.Slug, "_") {
			t.Errorf("system tag %s should not appear with publicOnly=true", tag.Slug)
		}
	}
}

func TestUpdatePost_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	post, err := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Original", Slug: "original", Content: "hello", Status: "draft", AuthorID: 1,
	})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}

	body, _ := json.Marshal(UpdatePostRequest{Title: "Updated Title", Content: "new content", Status: "published", Slug: "updated-slug"})
	req := httptest.NewRequest(http.MethodPut, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.UpdatePost(c); err != nil {
		t.Fatalf("UpdatePost success failed: %v", err)
	}
}

func TestPostHandler_PublishWithdraw_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	post, err := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "My Post", Slug: "my-post", Content: "hello", Status: "draft", AuthorID: 1,
	})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}
	idStr := strconv.FormatInt(post.ID, 10)

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(idStr)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.PublishPost(c); err != nil {
		t.Fatalf("PublishPost failed: %v", err)
	}

	req2 := httptest.NewRequest(http.MethodPost, "/", nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues(idStr)
	c2.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.WithdrawPost(c2); err != nil {
		t.Fatalf("WithdrawPost failed: %v", err)
	}
}

func TestPostHandler_GeneratePreviewLink_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	post, err := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Preview", Slug: "preview-post", Status: "draft", AuthorID: 1,
	})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.GeneratePreviewLink(c); err != nil {
		t.Fatalf("GeneratePreviewLink failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateAudioPost_NoTitleWithTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{
		StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300,
	}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	p, _ := writer.CreateFormFile("file", "my-audio.mp3")
	_, _ = p.Write([]byte("fake mp3 data"))
	_ = writer.WriteField("tags", "nature, landscape, , ")
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.CreateAudioPost(c); err != nil {
		t.Fatalf("CreateAudioPost (no title) failed: %v", err)
	}
}

func TestUpdatePost_SlugConflict(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)

	_, err := postSvc.CreatePost(ctx, services.CreatePostParams{Title: "Post A", Slug: "post-a", Status: "draft", AuthorID: 1})
	if err != nil {
		t.Fatalf("CreatePost A: %v", err)
	}
	postB, err := postSvc.CreatePost(ctx, services.CreatePostParams{Title: "Post B", Slug: "post-b", Status: "draft", AuthorID: 1})
	if err != nil {
		t.Fatalf("CreatePost B: %v", err)
	}

	body, _ := json.Marshal(UpdatePostRequest{Title: "Post B", Slug: "post-a", Status: "draft"})
	req := httptest.NewRequest(http.MethodPut, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(postB.ID, 10))
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	err = h.UpdatePost(c)
	if err != nil {
		t.Logf("UpdatePost conflict returned error (may be echo HTTPError): %v", err)
	}
	if rec.Code != http.StatusConflict && err == nil {
		t.Errorf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdatePost_BadID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPut, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("notanint")

	if err := h.UpdatePost(c); err == nil {
		t.Error("expected error for bad ID")
	}
}

func TestCreatePost_Scheduled(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)

	future := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	body := fmt.Sprintf(`{"title":"Scheduled","content":"hello","status":"draft","scheduled_at":%q}`, future)

	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.CreatePost(c); err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["status"] != "scheduled" {
		t.Errorf("expected status 'scheduled', got %v", resp["status"])
	}
	if resp["scheduled_at"] == nil {
		t.Error("expected scheduled_at to be non-nil")
	}
}

func TestCreatePost_ScheduledInPast_PublishesImmediately(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)

	past := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
	body := fmt.Sprintf(`{"title":"PastScheduled","content":"hello","scheduled_at":%q}`, past)

	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.CreatePost(c); err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["status"] != "published" {
		t.Errorf("expected status 'published', got %v", resp["status"])
	}
}
