package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestTagHandler_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagService := services.NewTagService(repo)
	settingsService := services.NewSettingsService(repo)
	handler := NewTagHandler(tagService, settingsService)

	e := echo.New()

	// Test Create
	reqBody, _ := json.Marshal(CreateTagRequest{
		Name: "Tag1",
	})
	req := httptest.NewRequest(http.MethodPost, "/tags", bytes.NewReader(reqBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.CreateTag(c); err != nil {
		t.Fatalf("CreateTag failed: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("expected status 201, got %d", rec.Code)
	}

	var created map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	tagID := int64(created["id"].(float64))

	// Test Get
	req = httptest.NewRequest(http.MethodGet, "/tags/1", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")

	if err := handler.GetTagByID(c); err != nil {
		t.Fatalf("GetTagByID failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test List
	req = httptest.NewRequest(http.MethodGet, "/tags", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)

	if err := handler.ListTags(c); err != nil {
		t.Fatalf("ListTags failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test Delete
	req = httptest.NewRequest(http.MethodDelete, "/tags/1", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(tagID, 10))

	if err := handler.DeleteTag(c); err != nil {
		t.Fatalf("DeleteTag failed: %v", err)
	}
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected status 204, got %d", rec.Code)
	}
}

func TestTagHandler_GetTagBySlug(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	handler := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	// Create a tag
	tag, _ := tagSvc.CreateTag(context.Background(), services.CreateTagParams{Name: "Travel"})

	// Found
	req := httptest.NewRequest(http.MethodGet, "/tags/slug/travel", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues(tag.Slug)
	if err := handler.GetTagBySlug(c); err != nil {
		t.Fatalf("GetTagBySlug failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Not found
	req = httptest.NewRequest(http.MethodGet, "/tags/slug/no-such-tag", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("no-such-tag")
	err := handler.GetTagBySlug(c)
	if err == nil {
		t.Error("expected error for missing tag")
	}
}

func TestTagHandler_UpdateTag(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	handler := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	tag, _ := tagSvc.CreateTag(context.Background(), services.CreateTagParams{Name: "OldName"})

	body, _ := json.Marshal(CreateTagRequest{Name: "NewName"})
	req := httptest.NewRequest(http.MethodPut, "/tags/1", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(tag.ID, 10))

	if err := handler.UpdateTag(c); err != nil {
		t.Fatalf("UpdateTag failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid ID
	req = httptest.NewRequest(http.MethodPut, "/tags/abc", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	err := handler.UpdateTag(c)
	if err == nil {
		t.Error("expected error for invalid ID")
	}

	// Non-existent tag
	body, _ = json.Marshal(CreateTagRequest{Name: "Ghost"})
	req = httptest.NewRequest(http.MethodPut, "/tags/9999", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("9999")
	err = handler.UpdateTag(c)
	if err == nil {
		t.Error("expected error for non-existent tag")
	}
}

func TestTagHandler_ReorderTag(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	handler := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	ctx := context.Background()
	t1, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Alpha"})
	t2, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Beta"})

	// Reorder t1 after t2
	body, _ := json.Marshal(ReorderTagRequest{TargetID: &t2.ID, Position: "after"})
	req := httptest.NewRequest(http.MethodPost, "/tags/1/reorder", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(t1.ID, 10))

	if err := handler.ReorderTag(c); err != nil {
		t.Fatalf("ReorderTag failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid ID
	req = httptest.NewRequest(http.MethodPost, "/tags/abc/reorder", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	err := handler.ReorderTag(c)
	if err == nil {
		t.Error("expected error for invalid ID")
	}
}

func TestTagHandler_GetPostsByTag(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	handler := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	ctx := context.Background()
	tag, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "MyTag"})

	// Found — returns posts (empty for now)
	req := httptest.NewRequest(http.MethodGet, "/tags/my-tag/posts", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues(tag.Slug)
	if err := handler.GetPostsByTag(c); err != nil {
		t.Fatalf("GetPostsByTag failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Not found slug
	req = httptest.NewRequest(http.MethodGet, "/tags/no-such/posts", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("no-such")
	err := handler.GetPostsByTag(c)
	if err == nil {
		t.Error("expected error for missing tag slug")
	}
}

func TestTagHandler_GetTagByIDBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	if err := h.GetTagByID(c); err == nil {
		t.Error("expected error for non-numeric ID")
	}

	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues("999")
	if err := h.GetTagByID(c2); err == nil {
		t.Error("expected error for non-existent tag ID")
	}
}

func TestTagHandler_DeleteTagBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	if err := h.DeleteTag(c); err == nil {
		t.Error("expected error for non-numeric ID")
	}
}

func TestTagHandler_RecalculateCounts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.RecalculateCounts(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RecalculateCounts failed: %v", err)
	}
}

func TestTagHandler_GetTagByIDWithLocation(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (1,45.5,73.5)`)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")

	if err := h.GetTagByID(c); err != nil {
		t.Fatalf("GetTagByID with location failed: %v", err)
	}
}

func TestRecalculateCounts_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.RecalculateCounts(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RecalculateCounts failed: %v", err)
	}
}

func TestGetMinTagPostsSetting(t *testing.T) {
	settings := map[string]string{"min_tag_posts_to_show": "3"}
	if v := getMinTagPostsSetting(settings); v != 3 {
		t.Errorf("expected 3, got %d", v)
	}
	if v := getMinTagPostsSetting(map[string]string{}); v != 0 {
		t.Errorf("expected 0, got %d", v)
	}
	if v := getMinTagPostsSetting(map[string]string{"min_tag_posts_to_show": "-5"}); v != 0 {
		t.Errorf("expected 0 for negative, got %d", v)
	}
}

func TestTagHandler_ListTags_DBError(t *testing.T) {
	h := setupHandlers(t)
	_ = h.repo.Close()
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

	_, _ = h.repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Parent','parent'),(2,'Child','child')`)
	_, _ = h.repo.DB().Exec(`INSERT INTO tag_relationships (parent_id,child_id) VALUES (1,2)`)

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
	_ = h.repo.Close()
	th := NewTagHandler(h.tagSvc, h.settingsSvc)
	c, _ := echoCtx(http.MethodPost, "/", `{"name":"New","slug":"new"}`)
	err := th.CreateTag(c)
	if err == nil {
		t.Error("expected error")
	}
}

func TestTagHandler_DeleteTag_DBError(t *testing.T) {
	h := setupHandlers(t)
	_ = h.repo.Close()
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
	_ = h.repo.Close()
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
	_ = h.repo.Close()
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
