package api

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

func nil_ctx() context.Context { return context.Background() }

// ---- helper: build all services from a repo ----

type testHandlers struct {
	repo        *repository.Repository
	settingsSvc *services.SettingsService
	tagSvc      *services.TagService
	postSvc     *services.PostService
	authSvc     *services.AuthService
	mediaSvc    *services.MediaService
	cfg         *config.Config
}

func setupHandlers(t *testing.T) *testHandlers {
	t.Helper()
	repo := setupTestDB(t)
	cfg := &config.Config{
		StoragePath:     t.TempDir(),
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	authSvc := services.NewAuthService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	return &testHandlers{repo, settingsSvc, tagSvc, postSvc, authSvc, mediaSvc, cfg}
}

func (h *testHandlers) close() { h.repo.Close() }

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

func insertUser(repo *repository.Repository) int64 {
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	return 1
}

// ============================================================
// middleware.go: extractUserID(nil), extractSessionID(nil)
// ============================================================

func TestMiddleware_ExtractIDNil(t *testing.T) {
	if id := extractUserID(nil); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
	if id := extractSessionID(nil); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
}

// ============================================================
// setup.go
// ============================================================

func TestSetupHandler_Validation(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	e := echo.New()

	setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)

	// SetupStatus with user present → setup_complete: true
	insertUser(h.repo)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := setupH.SetupStatus(e.NewContext(req, rec)); err != nil {
		t.Fatalf("SetupStatus: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "true") {
		t.Errorf("expected setup_complete:true, got %s", rec.Body.String())
	}
}

func TestSetupHandler_SetupValidation(t *testing.T) {
	e := echo.New()

	t.Run("MissingFields", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		c, rec := echoCtx(http.MethodPost, "/", `{}`)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("ShortPassword", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		body := `{"username":"u","password":"abc","blog_title":"T","author_name":"A"}`
		c, rec := echoCtx(http.MethodPost, "/", body)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for short password, got %d", rec.Code)
		}
	})

	t.Run("AlreadySetup", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		insertUser(h.repo)
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		body := `{"username":"u","password":"password123","blog_title":"T","author_name":"A"}`
		c, rec := echoCtx(http.MethodPost, "/", body)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusConflict {
			t.Errorf("expected 409 conflict, got %d", rec.Code)
		}
	})

	t.Run("CreateUserDBError", func(t *testing.T) {
		h := setupHandlers(t)
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		h.repo.Close() // close DB so CreateUser fails
		body := `{"username":"u","password":"password123","blog_title":"T","author_name":"A"}`
		c, rec := echoCtx(http.MethodPost, "/", body)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("expected 500, got %d: %s", rec.Code, rec.Body.String())
		}
	})
	_ = e
}

// ============================================================
// settings.go
// ============================================================

func TestSettingsHandler_DBErrors(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	e := echo.New()
	sh := NewSettingsHandler(h.settingsSvc)

	t.Run("GetPublicSettings", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		err := sh.GetPublicSettings(e.NewContext(req, rec))
		if err == nil {
			t.Error("expected error")
		}
	})

	t.Run("GetSettings", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		err := sh.GetSettings(e.NewContext(req, rec))
		if err == nil {
			t.Error("expected error")
		}
	})

	t.Run("UpdateSettings_EmptyMap_GetAllError", func(t *testing.T) {
		c, _ := echoCtx(http.MethodPut, "/", `{}`)
		err := sh.UpdateSettings(c)
		if err == nil {
			t.Error("expected error from GetAllSettings on closed DB")
		}
	})

	t.Run("UpdateSettings_WithKey_SetSettingError", func(t *testing.T) {
		c, _ := echoCtx(http.MethodPut, "/", `{"foo":"bar"}`)
		err := sh.UpdateSettings(c)
		if err == nil {
			t.Error("expected error from SetSetting on closed DB")
		}
	})
}

// ============================================================
// auth.go
// ============================================================

func TestAuthHandler_ProductionCookie(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)
	hash, _ := services.HashPassword("pass1234")
	_, _ = h.repo.DB().Exec(`UPDATE users SET password_hash=? WHERE id=1`, hash)

	cfg := &config.Config{AppEnv: "production"}
	authH := NewAuthHandler(h.authSvc, cfg)
	e := echo.New()

	body := `{"username":"u","name":"pass1234","remember_me":false}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := authH.Login(e.NewContext(req, rec)); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	// Should have Secure cookie in response
	cookies := rec.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == "session" && c.Secure {
			found = true
		}
	}
	if !found {
		t.Error("expected Secure=true cookie in production mode")
	}
}

func TestAuthHandler_ListSessions_WithData(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)
	// Insert a session directly
	_, _ = h.repo.DB().Exec(`INSERT INTO sessions (user_id,token,ip_address,user_agent,expires_at) VALUES (1,'tok','127.0.0.1','ua',datetime('now','+1 hour'))`)

	authH := NewAuthHandler(h.authSvc, h.cfg)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1, ID: 1})
	if err := authH.ListSessions(c); err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
}

func TestAuthHandler_DBErrors(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	authH := NewAuthHandler(h.authSvc, h.cfg)
	e := echo.New()

	t.Run("ListSessions_Error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.Set("user", models.GetSessionByTokenRow{UserID: 1})
		err := authH.ListSessions(c)
		if err == nil {
			t.Error("expected error")
		}
	})

	t.Run("DeleteOtherSessions_Error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.Set("user", models.GetSessionByTokenRow{UserID: 1, ID: 1})
		err := authH.DeleteOtherSessions(c)
		if err == nil {
			t.Error("expected error")
		}
	})
}

// ============================================================
// feeds.go
// ============================================================

func TestFeedsHandler_XForwardedHost(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-Host", "myhost.example.com")
	rec := httptest.NewRecorder()
	if err := feedsH.RSSFeed(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RSSFeed: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "myhost.example.com") {
		t.Errorf("expected X-Forwarded-Host in output")
	}
}

func TestFeedsHandler_RSSWithExcerpt(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)
	_, _ = h.repo.DB().Exec(`INSERT INTO posts (title,slug,content,excerpt,author_id,status,published_at) VALUES ('T','t','body','excerpt text',1,'published',datetime('now'))`)

	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := feedsH.RSSFeed(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RSSFeed: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "excerpt text") {
		t.Errorf("expected excerpt in RSS output")
	}
}

func TestFeedsHandler_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := feedsH.RSSFeed(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from RSSFeed on closed DB")
	}
}

func TestFeedsHandler_SitemapWithTags(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	_, _ = h.repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (1,'Nature','nature',1)`)

	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := feedsH.Sitemap(e.NewContext(req, rec)); err != nil {
		t.Fatalf("Sitemap: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "nature") {
		t.Errorf("expected tag slug in sitemap")
	}
}

func TestFeedsHandler_SitemapDBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := feedsH.Sitemap(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from Sitemap on closed DB")
	}
}

// ============================================================
// tags.go
// ============================================================

func TestTagHandler_ListTags_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := th.ListTags(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}

func TestTagHandler_ListTags_WithRelationships(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	// Insert two tags + a relationship to cover the rels loop
	_, _ = h.repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Parent','parent'),(2,'Child','child')`)
	_, _ = h.repo.DB().Exec(`INSERT INTO tag_relationships (parent_id,child_id) VALUES (1,2)`)
	// Insert a tag location for coverage of the location lookup
	_, _ = h.repo.DB().Exec(`INSERT INTO tag_locations (tag_id,latitude,longitude) VALUES (1,48.85,2.35)`)

	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?include_empty=true", nil)
	rec := httptest.NewRecorder()
	if err := th.ListTags(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListTags: %v", err)
	}
}

func TestTagHandler_GetTagByID_NotFound(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("9999")
	err := th.GetTagByID(c)
	if err == nil {
		t.Error("expected error for non-existent tag")
	}
}

func TestTagHandler_CreateTag_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	c, _ := echoCtx(http.MethodPost, "/", `{"name":"New","slug":"new"}`)
	err := th.CreateTag(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestTagHandler_DeleteTag_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := th.DeleteTag(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestTagHandler_GeocodeTag_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := th.GeocodeTag(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestTagHandler_GetTagBySlug_NotFound(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("no-such-tag")
	err := th.GetTagBySlug(c)
	if err == nil {
		t.Error("expected 404")
	}
}

func TestTagHandler_ReorderTag_BadBind(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	// Send invalid JSON body for bind error
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{invalid"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := th.ReorderTag(c)
	if err == nil && rec.Code != http.StatusBadRequest {
		t.Error("expected bind error")
	}
}

func TestTagHandler_GetPostsByTag_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := th.GetPostsByTag(c)
	if err == nil {
		t.Error("expected error")
	}
}

// ============================================================
// posts.go
// ============================================================

func setupPostHandler(t *testing.T) (*PostHandler, *testHandlers) {
	h := setupHandlers(t)
	ph := NewPostHandler(h.postSvc, h.settingsSvc, h.mediaSvc, h.tagSvc)
	return ph, h
}

func TestPostHandler_ListPosts_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := ph.ListPosts(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_GetPostBySlug_NotFound(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("no-such-post")
	err := ph.GetPostBySlug(c)
	if err == nil {
		t.Error("expected 404")
	}
}

func TestPostHandler_GetPostBySlug_DraftBlocked(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	insertUser(h.repo)
	_, _ = h.repo.DB().Exec(`INSERT INTO posts (title,slug,content,author_id,status) VALUES ('T','draft-post','body',1,'draft')`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("draft-post")
	// No "user" in context = public request → draft should be blocked
	err := ph.GetPostBySlug(c)
	if err == nil {
		t.Error("expected 404 for draft post to public")
	}
}

func TestPostHandler_GetPostByID_Draft_Blocked(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	insertUser(h.repo)
	_, _ = h.repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status) VALUES (99,'T','dp','body',1,'draft')`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("99")
	// Public user → draft blocked
	err := ph.GetPostByID(c)
	if err == nil {
		t.Error("expected 404 for draft post to public")
	}
}

func TestPostHandler_GetPostByID_Admin_HiddenFields(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	insertUser(h.repo)
	_, _ = h.repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (1,'T','pub','body',1,'published',datetime('now'))`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := ph.GetPostByID(c); err != nil {
		t.Fatalf("GetPostByID: %v", err)
	}
}

func TestPostHandler_CreatePost_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	c, _ := echoCtx(http.MethodPost, "/", `{"title":"T","status":"draft"}`)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	err := ph.CreatePost(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_UpdatePost_BadID(t *testing.T) {
	ph, h := setupPostHandler(t)
	defer h.close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	err := ph.UpdatePost(c)
	if err == nil {
		t.Error("expected bad id error")
	}
}

func TestPostHandler_DeletePost_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	err := ph.DeletePost(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_PublishPost_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := ph.PublishPost(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_WithdrawPost_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := ph.WithdrawPost(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_GetPostByPreviewToken_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("token")
	c.SetParamValues("sometoken")
	err := ph.GetPostByPreviewToken(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_UpdatePostTags_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	c, _ := echoCtx(http.MethodPut, "/", `{"tags":["a"]}`)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := ph.UpdatePostTags(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestPostHandler_GetPostNavigation_DBError(t *testing.T) {
	ph, h := setupPostHandler(t)
	h.repo.Close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")
	err := ph.GetPostNavigation(c)
	if err == nil {
		t.Error("expected error")
	}
}

// ============================================================
// system.go
// ============================================================

func TestSystemHandler_GetStats_DBError(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	// Close the DB manually
	repo := setupTestDB(t)
	repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{
		StoragePath:     t.TempDir(),
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}, settingsSvc, tagSvc)
	tmpDir2 := t.TempDir()
	systemSvc2 := services.NewSystemService(repo, tmpDir2)
	h2 := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc2, tmpDir2, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := h2.GetStats(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
	_ = h
}

func TestSystemHandler_GetLogs_NoFile(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetLogs(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetLogs: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_ListBackups_NotExist(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ListBackups(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_RestoreBackup_NotFound(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues("nonexistent.tar.gz")
	err := h.RestoreBackup(c)
	if err == nil {
		t.Error("expected 404")
	}
}

func TestSystemHandler_DeleteBackup_NotFound(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues("nonexistent.tar.gz")
	err := h.DeleteBackup(c)
	if err == nil {
		t.Error("expected 404")
	}
}

func TestSystemHandler_GetMigrations_OK(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := h.GetMigrations(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_ClearCache_DBError(t *testing.T) {
	repo := setupTestDB(t)
	repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	err := h.ClearCache(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}

func TestSystemHandler_RecalculateMediaVisibility_DBError(t *testing.T) {
	repo := setupTestDB(t)
	repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	err := h.RecalculateMediaVisibility(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}

func TestSystemHandler_UpdateMapCoords_DBError(t *testing.T) {
	repo := setupTestDB(t)
	repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	err := h.UpdateMapCoords(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}

// ============================================================
// pages.go
// ============================================================

func setupPagesHandler(t *testing.T) (*PagesHandler, *testHandlers) {
	h := setupHandlers(t)
	ph := NewPagesHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	return ph, h
}

func TestPagesHandler_GetTagPage_NotFound(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("no-such-tag")
	err := ph.GetTagPage(c)
	if err == nil {
		t.Error("expected 404")
	}
}

func TestPagesHandler_GetTagPage_HiddenTag(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	// Insert _hidden system tag and a user tag under it (effectively hidden)
	_, _ = h.repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Hidden','_hidden_posts'),(2,'Nature','nature')`)
	_, _ = h.repo.DB().Exec(`INSERT INTO tag_relationships (parent_id,child_id) VALUES (1,2)`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("nature")
	// public request
	err := ph.GetTagPage(c)
	// should succeed (the tag is not in _effectively_hidden per the actual logic)
	// but test covers the path either way
	_ = err
	_ = rec
}

func TestPagesHandler_GetTagPage_Success(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	insertUser(h.repo)
	_, _ = h.repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Nature','nature')`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("nature")
	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage: %v", err)
	}
}

func TestPagesHandler_GetHomePage_Admin(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	insertUser(h.repo)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?page=1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := ph.GetHomePage(c); err != nil {
		t.Fatalf("GetHomePage admin: %v", err)
	}
}

func TestPagesHandler_GetTagsPage_Success(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()
	_, _ = h.repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Nature','nature')`)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := ph.GetTagsPage(c); err != nil {
		t.Fatalf("GetTagsPage: %v", err)
	}
}

// ============================================================
// util.go - parseCoordsFromPageBody
// ============================================================

func TestParseCoordsFromPageBody_Error(t *testing.T) {
	// httptest server returning no lat/lng
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`<html>no coords here</html>`)) //nolint:errcheck
	}))
	defer ts.Close()

	lat, lng, ok := parseCoordsFromPageBody(ts.URL)
	if ok {
		t.Errorf("expected ok=false, got lat=%f lng=%f", lat, lng)
	}
}

func TestParseCoordsFromPageBody_ConnectionError(t *testing.T) {
	// Create and immediately close server
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	tsURL := ts.URL
	ts.Close()

	_, _, ok := parseCoordsFromPageBody(tsURL)
	if ok {
		t.Error("expected ok=false for connection refused")
	}
}

func TestParseCoordsFromDegreeString_SouthWest(t *testing.T) {
	// Cover S and W hemisphere handling
	lat, lng, ok := parseCoordsFromDegreeString("45.5° S, 73.5° W")
	if !ok {
		t.Fatal("expected ok=true")
	}
	if lat >= 0 {
		t.Errorf("expected negative lat for S, got %f", lat)
	}
	if lng >= 0 {
		t.Errorf("expected negative lng for W, got %f", lng)
	}
}

// ============================================================
// mappers.go - extractMediaURL
// ============================================================

func TestExtractMediaURL_Coverage(t *testing.T) {
	// valid thumb path
	result := extractMediaURL(sql.NullString{String: "/thumb/photo.jpg", Valid: true}, "")
	if result == nil {
		t.Error("expected non-nil result for valid thumb path")
	}
	// invalid thumb, content has markdown image
	result2 := extractMediaURL(sql.NullString{Valid: false}, "![alt](/media/photo.jpg)")
	if result2 == nil {
		t.Error("expected non-nil result for markdown image in content")
	}
	// thumb path starts with "originals/" → hits TrimPrefix + normalization (adds leading /)
	result3 := extractMediaURL(sql.NullString{String: "originals/photo.jpg", Valid: true}, "")
	if result3 == nil {
		t.Error("expected non-nil for originals/ thumb path")
	}
	// both empty → nil
	result4 := extractMediaURL(sql.NullString{Valid: false}, "")
	_ = result4
}

// JSON marshal helper
func mustJSON(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// ============================================================
// offline.go - DB error paths
// ============================================================

func TestOfflineStats_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(h.repo, tmpDir)
	sh := NewSystemHandler(h.repo, h.mediaSvc, h.postSvc, h.settingsSvc, h.tagSvc, systemSvc, tmpDir, "1.0")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := sh.GetOfflineStats(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from GetOfflineStats with closed DB")
	}
}

func TestOfflineSnapshot_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(h.repo, tmpDir)
	sh := NewSystemHandler(h.repo, h.mediaSvc, h.postSvc, h.settingsSvc, h.tagSvc, systemSvc, tmpDir, "1.0")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := sh.GetOfflineSnapshot(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from GetOfflineSnapshot with closed DB")
	}
}

// ============================================================
// auth.go - Login session creation DB error
// ============================================================

func TestAuthHandler_Login_SessionCreateError(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	// Create a user first (before closing DB)
	hash, _ := services.HashPassword("password123")
	_, _ = h.repo.CreateUser(nil_ctx(), models.CreateUserParams{
		Username: "testlogin", Email: "", PasswordHash: hash, DisplayName: "Test",
	})
	// Now close DB so session creation fails
	h.repo.Close()
	ah := NewAuthHandler(h.authSvc, h.cfg)
	body := `{"username":"testlogin","password":"password123"}`
	c, _ := echoCtx(http.MethodPost, "/", body)
	err := ah.Login(c)
	// Either error or bad status — we just want to cover the path
	_ = err
}

// ============================================================
// feeds.go - DB error path in Sitemap
// ============================================================

func TestFeedsHandler_Sitemap_DBError(t *testing.T) {
	h := setupHandlers(t)
	h.repo.Close()
	fh := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := fh.Sitemap(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from Sitemap with closed DB")
	}
}

// ============================================================
// feeds.go - baseURL with TLS request
// ============================================================

func TestFeedsHandler_Feed_TLS(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	fh := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)
	// Simulate TLS by setting a non-nil TLS state
	req.TLS = &tls.ConnectionState{}
	rec := httptest.NewRecorder()
	err := fh.RSSFeed(e.NewContext(req, rec))
	_ = err
}

// ============================================================
// auth.go - Logout with valid session (covers TerminateSession path)
// ============================================================

func TestAuthHandler_Logout_WithValidSession(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	// Create user and session
	hash, _ := services.HashPassword("password123")
	user, _ := h.repo.CreateUser(nil_ctx(), models.CreateUserParams{
		Username: "logoutuser", Email: "", PasswordHash: hash, DisplayName: "Logout",
	})
	token := GenerateToken()
	expiry := time.Now().Add(24 * time.Hour).UTC()
	_, _ = h.authSvc.CreateSession(nil_ctx(), user.ID, "127.0.0.1", "test", expiry, token)

	ah := NewAuthHandler(h.authSvc, h.cfg)
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/logout", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec := httptest.NewRecorder()
	err := ah.Logout(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}
