package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestTagHandler_PatchPartialSemantics(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagService := services.NewTagService(repo)
	settingsService := services.NewSettingsService(repo)
	handler := NewTagHandler(tagService, settingsService)

	e := echo.New()

	// 1. Create a tag with all fields set
	ctx := context.Background()
	lat := 1.23
	lon := 4.56
	nav := int64(2)
	tag, err := tagService.CreateTag(ctx, services.CreateTagParams{
		Name:        "Original Name",
		Description: "Original Description",
		Latitude:    &lat,
		Longitude:   &lon,
		NavOrder:    &nav,
	})
	if err != nil {
		t.Fatalf("CreateTag failed: %v", err)
	}

	tagIDStr := fmt.Sprintf("%d", tag.ID)

	// 2. PATCH only {"hidden": true}
	patch1 := map[string]interface{}{
		"hidden": true,
	}
	reqBody1, _ := json.Marshal(patch1)
	req1 := httptest.NewRequest(http.MethodPatch, "/api/tags/"+tagIDStr, bytes.NewReader(reqBody1))
	req1.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec1 := httptest.NewRecorder()
	c1 := e.NewContext(req1, rec1)
	c1.SetParamNames("id")
	c1.SetParamValues(tagIDStr)

	if err := handler.PatchTag(c1); err != nil {
		t.Fatalf("PatchTag 1 failed: %v", err)
	}
	if rec1.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec1.Code)
	}

	// Verify fields
	updated1, err := tagService.GetTagByID(ctx, tag.ID)
	if err != nil {
		t.Fatalf("GetTagByID failed: %v", err)
	}
	if !updated1.Hidden {
		t.Error("expected hidden to be true")
	}
	if updated1.Name != "Original Name" {
		t.Errorf("expected name to remain 'Original Name', got %s", updated1.Name)
	}
	if updated1.Description.String != "Original Description" {
		t.Errorf("expected description to remain 'Original Description', got %s", updated1.Description.String)
	}
	if !updated1.NavOrder.Valid || updated1.NavOrder.Int64 != 2 {
		t.Errorf("expected nav_order to remain 2, got %v", updated1.NavOrder)
	}
	if !updated1.Latitude.Valid || updated1.Latitude.Float64 != 1.23 {
		t.Errorf("expected latitude to remain 1.23, got %v", updated1.Latitude)
	}

	// 3. PATCH {"nav_order": null}
	patch2 := map[string]interface{}{
		"nav_order": nil,
	}
	reqBody2, _ := json.Marshal(patch2)
	req2 := httptest.NewRequest(http.MethodPatch, "/api/tags/"+tagIDStr, bytes.NewReader(reqBody2))
	req2.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues(tagIDStr)

	if err := handler.PatchTag(c2); err != nil {
		t.Fatalf("PatchTag 2 failed: %v", err)
	}
	if rec2.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec2.Code)
	}

	// Verify fields
	updated2, err := tagService.GetTagByID(ctx, tag.ID)
	if err != nil {
		t.Fatalf("GetTagByID failed: %v", err)
	}
	if updated2.NavOrder.Valid {
		t.Error("expected nav_order to be null")
	}
	if !updated2.Hidden {
		t.Error("expected hidden to stay true")
	}
	if updated2.Name != "Original Name" {
		t.Errorf("expected name to remain 'Original Name', got %s", updated2.Name)
	}
}

// TestTagHandler_PutPartialSemantics verifies PUT /api/tags/:id keeps
// omitted fields (regression: a {hides_posts}-only update used to wipe
// name, slug, kind, in_ancestor_flyout, and parent relationships).
func TestTagHandler_PutPartialSemantics(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagService := services.NewTagService(repo)
	settingsService := services.NewSettingsService(repo)
	handler := NewTagHandler(tagService, settingsService)

	e := echo.New()
	ctx := context.Background()

	parent, err := tagService.CreateTag(ctx, services.CreateTagParams{Name: "Parent"})
	if err != nil {
		t.Fatalf("CreateTag parent failed: %v", err)
	}
	tag, err := tagService.CreateTag(ctx, services.CreateTagParams{
		Name:             "Feature",
		Slug:             "feature",
		Kind:             "topic",
		InAncestorFlyout: true,
		ParentIDs:        []int64{parent.ID},
	})
	if err != nil {
		t.Fatalf("CreateTag failed: %v", err)
	}
	tagIDStr := fmt.Sprintf("%d", tag.ID)

	body, _ := json.Marshal(map[string]interface{}{"hides_posts": true})
	req := httptest.NewRequest(http.MethodPut, "/api/tags/"+tagIDStr, bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(tagIDStr)

	if err := handler.UpdateTag(c); err != nil {
		t.Fatalf("UpdateTag failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	updated, err := tagService.GetTagByID(ctx, tag.ID)
	if err != nil {
		t.Fatalf("GetTagByID failed: %v", err)
	}
	if !updated.HidesPosts {
		t.Error("expected hides_posts to be true")
	}
	if updated.Name != "Feature" || updated.Slug != "feature" || updated.Kind != "topic" {
		t.Errorf("expected name/slug/kind preserved, got %q/%q/%q", updated.Name, updated.Slug, updated.Kind)
	}
	if !updated.InAncestorFlyout {
		t.Error("expected in_ancestor_flyout to stay true")
	}
	g, err := tagService.GetTagSnapshot(ctx)
	if err != nil {
		t.Fatalf("GetTagSnapshot failed: %v", err)
	}
	if len(g.Parents[tag.ID]) != 1 || g.Parents[tag.ID][0] != parent.ID {
		t.Errorf("expected parent %d preserved, got %v", parent.ID, g.Parents[tag.ID])
	}

	// An explicit empty parent_ids array still clears relationships.
	body, _ = json.Marshal(map[string]interface{}{"parent_ids": []int64{}})
	req = httptest.NewRequest(http.MethodPut, "/api/tags/"+tagIDStr, bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(tagIDStr)
	if err := handler.UpdateTag(c); err != nil {
		t.Fatalf("UpdateTag clear parents failed: %v", err)
	}
	g, err = tagService.GetTagSnapshot(ctx)
	if err != nil {
		t.Fatalf("GetTagSnapshot failed: %v", err)
	}
	if len(g.Parents[tag.ID]) != 0 {
		t.Errorf("expected parents cleared, got %v", g.Parents[tag.ID])
	}
}
