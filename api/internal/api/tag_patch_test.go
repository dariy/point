package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/models"
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

// patchFixture is a tag with every optional column populated, so a test can
// tell "left alone" apart from "cleared".
func patchFixture() models.Tag {
	return models.Tag{
		ID:          7,
		Name:        "Original",
		Slug:        "original",
		Kind:        "topic",
		Description: sql.NullString{String: "Original text", Valid: true},
		NavOrder:    sql.NullInt64{Int64: 2, Valid: true},
		Latitude:    sql.NullFloat64{Float64: 1.23, Valid: true},
		Longitude:   sql.NullFloat64{Float64: 4.56, Valid: true},
	}
}

func decodeFields(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &fields); err != nil {
		t.Fatalf("bad test body %q: %v", body, err)
	}
	return fields
}

// TestTagPatchParams_PresentKeySemantics pins the absent/null/value distinction
// the PUT and PATCH bodies rely on, one field at a time.
func TestTagPatchParams_PresentKeySemantics(t *testing.T) {
	tests := []struct {
		name  string
		body  string
		check func(t *testing.T, p services.UpdateTagParams)
	}{
		{
			name: "an empty body changes nothing",
			body: `{}`,
			check: func(t *testing.T, p services.UpdateTagParams) {
				if p.Name != "Original" || p.Slug != "original" || p.Kind != "topic" {
					t.Errorf("scalars changed: %+v", p)
				}
				if p.Description != "Original text" {
					t.Errorf("description = %q, want the seeded text", p.Description)
				}
				if p.NavOrder == nil || *p.NavOrder != 2 {
					t.Errorf("nav_order = %v, want 2", p.NavOrder)
				}
				if p.Latitude == nil || *p.Latitude != 1.23 {
					t.Errorf("latitude = %v, want 1.23", p.Latitude)
				}
			},
		},
		{
			name: "a present scalar overrides",
			body: `{"name":"Renamed","hidden":true}`,
			check: func(t *testing.T, p services.UpdateTagParams) {
				if p.Name != "Renamed" {
					t.Errorf("name = %q, want Renamed", p.Name)
				}
				if !p.Hidden {
					t.Error("hidden should be true")
				}
				if p.Slug != "original" {
					t.Errorf("slug = %q, want it untouched", p.Slug)
				}
			},
		},
		{
			name: "null clears the nullable numbers",
			body: `{"nav_order":null,"latitude":null,"longitude":null}`,
			check: func(t *testing.T, p services.UpdateTagParams) {
				if p.NavOrder != nil || p.Latitude != nil || p.Longitude != nil {
					t.Errorf("expected all three cleared, got %v/%v/%v", p.NavOrder, p.Latitude, p.Longitude)
				}
			},
		},
		{
			name: "null clears the description",
			body: `{"description":null}`,
			check: func(t *testing.T, p services.UpdateTagParams) {
				if p.Description != "" {
					t.Errorf("description = %q, want cleared", p.Description)
				}
			},
		},
		{
			name: "a present nullable is set even when it does not parse",
			body: `{"nav_order":"nonsense"}`,
			check: func(t *testing.T, p services.UpdateTagParams) {
				if p.NavOrder == nil || *p.NavOrder != 0 {
					t.Errorf("nav_order = %v, want a zero value (the key was present)", p.NavOrder)
				}
			},
		},
		{
			name: "an unparseable scalar leaves the current value",
			body: `{"name":123}`,
			check: func(t *testing.T, p services.UpdateTagParams) {
				if p.Name != "Original" {
					t.Errorf("name = %q, want the seeded value", p.Name)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := tagPatchParams(patchFixture(), decodeFields(t, tc.body))
			if p.ID != 7 {
				t.Errorf("id = %d, want 7", p.ID)
			}
			tc.check(t, p)
		})
	}
}

func TestPatchIDList(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantIDs []int64
		wantOK  bool
	}{
		{"absent key is left untouched", `{}`, nil, false},
		{"null is left untouched", `{"parent_ids":null}`, nil, false},
		{"a malformed value is left untouched", `{"parent_ids":"1,2"}`, nil, false},
		{"an empty array clears", `{"parent_ids":[]}`, []int64{}, true},
		{"a populated array replaces", `{"parent_ids":[1,2]}`, []int64{1, 2}, true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ids, ok := patchIDList(decodeFields(t, tc.body), "parent_ids")
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if len(ids) != len(tc.wantIDs) {
				t.Fatalf("ids = %v, want %v", ids, tc.wantIDs)
			}
			for i := range ids {
				if ids[i] != tc.wantIDs[i] {
					t.Fatalf("ids = %v, want %v", ids, tc.wantIDs)
				}
			}
		})
	}
}
