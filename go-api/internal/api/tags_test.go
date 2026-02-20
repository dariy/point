package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

func TestTagHandler_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
	json.Unmarshal(rec.Body.Bytes(), &created)
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
