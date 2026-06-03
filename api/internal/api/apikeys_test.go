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

func TestApiKeyHandler(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	apiKeyService := services.NewApiKeyService(repo)
	handler := NewApiKeyHandler(apiKeyService)

	e := echo.New()

	// Create test user
	user, err := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username:     "apikeyuser",
		Email:        "apikey@example.com",
		PasswordHash: "hash",
		DisplayName:  "API Key User",
	})
	if err != nil {
		t.Fatalf("failed to create test user: %v", err)
	}

	// Helper to create context with user
	createCtx := func(method, path string, body interface{}) (echo.Context, *httptest.ResponseRecorder) {
		var req *http.Request
		if body != nil {
			b, _ := json.Marshal(body)
			req = httptest.NewRequest(method, path, bytes.NewReader(b))
			req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		} else {
			req = httptest.NewRequest(method, path, nil)
		}
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		
		// Set user in context to simulate AuthMiddleware
		session := models.GetSessionByTokenRow{UserID: user.ID, Username: user.Username}
		c.Set("user", session)
		
		return c, rec
	}

	t.Run("CreateKey", func(t *testing.T) {
		reqBody := CreateApiKeyRequest{Name: "test-key"}
		c, rec := createCtx(http.MethodPost, "/api/auth/api-keys", reqBody)

		err := handler.CreateKey(c)
		if err != nil {
			t.Fatalf("CreateKey failed: %v", err)
		}

		if rec.Code != http.StatusCreated {
			t.Errorf("expected status 201, got %d", rec.Code)
		}

		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to parse response: %v", err)
		}

		if resp["raw_key"] == nil || resp["raw_key"] == "" {
			t.Error("expected raw_key in response")
		}
		apiKeyMap, ok := resp["api_key"].(map[string]interface{})
		if !ok || apiKeyMap["name"] != "test-key" {
			t.Error("expected api_key object with correct name")
		}
	})

	t.Run("CreateKey_Validation", func(t *testing.T) {
		reqBody := CreateApiKeyRequest{Name: ""}
		c, rec := createCtx(http.MethodPost, "/api/auth/api-keys", reqBody)

		err := handler.CreateKey(c)
		httpErr, ok := err.(*echo.HTTPError)
		if !ok || httpErr.Code != http.StatusBadRequest {
			t.Errorf("expected 400 Bad Request, got %v", err)
		}
		_ = rec
	})

	t.Run("ListKeys", func(t *testing.T) {
		c, rec := createCtx(http.MethodGet, "/api/auth/api-keys", nil)

		err := handler.ListKeys(c)
		if err != nil {
			t.Fatalf("ListKeys failed: %v", err)
		}

		if rec.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", rec.Code)
		}

		var resp map[string]interface{}
		json.Unmarshal(rec.Body.Bytes(), &resp)
		
		if resp["total"].(float64) < 1 {
			t.Error("expected at least 1 key")
		}
	})

	t.Run("RevokeAndDeleteKey", func(t *testing.T) {
		// First list keys to get an ID
		keys, _ := apiKeyService.ListKeys(context.Background(), user.ID)
		if len(keys) == 0 {
			t.Fatal("no keys to revoke")
		}
		keyID := keys[0].ID
		idStr := strconv.FormatInt(keyID, 10)

		// Revoke
		c, rec := createCtx(http.MethodPost, "/api/auth/api-keys/"+idStr+"/revoke", nil)
		c.SetParamNames("id")
		c.SetParamValues(idStr)

		err := handler.RevokeKey(c)
		if err != nil {
			t.Fatalf("RevokeKey failed: %v", err)
		}
		if rec.Code != http.StatusNoContent {
			t.Errorf("expected 204, got %d", rec.Code)
		}

		// Delete
		c, rec = createCtx(http.MethodDelete, "/api/auth/api-keys/"+idStr, nil)
		c.SetParamNames("id")
		c.SetParamValues(idStr)

		err = handler.DeleteKey(c)
		if err != nil {
			t.Fatalf("DeleteKey failed: %v", err)
		}
		if rec.Code != http.StatusNoContent {
			t.Errorf("expected 204, got %d", rec.Code)
		}
	})
	
	t.Run("InvalidID", func(t *testing.T) {
		c, _ := createCtx(http.MethodPost, "/api/auth/api-keys/invalid/revoke", nil)
		c.SetParamNames("id")
		c.SetParamValues("invalid")
		err := handler.RevokeKey(c)
		if err == nil {
			t.Error("expected error for invalid id")
		}
		
		c, _ = createCtx(http.MethodDelete, "/api/auth/api-keys/invalid", nil)
		c.SetParamNames("id")
		c.SetParamValues("invalid")
		err = handler.DeleteKey(c)
		if err == nil {
			t.Error("expected error for invalid id")
		}
	})
}