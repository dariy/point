package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestPostHandler_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
	json.Unmarshal(rec.Body.Bytes(), &created)
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
