# Secrets Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a physically separate `blog_secrets` table so sensitive values can never accidentally appear in API responses, replace all ad-hoc masking with structural separation, and remove the obsolete `genai_api_endpoint` dead code path.

**Architecture:** Three categories: `blog_settings` (normal admin settings), `blog_secrets` (write-only/invisible secrets — `gemini_api_key`, `media_import_path`, `_secret_key`), and synthetic `*_is_set` boolean properties injected into the settings API response. `SettingsService` gains `GetSecret`/`SetSecret`/`SecretIsSet`/`EnsureSecretKey` methods. Startup migrations move existing rows out of `blog_settings`. The frontend only ever sees `gemini_api_key_is_set` and `media_import_path_is_set` — never the values.

**Tech Stack:** Go 1.25, Echo v4, SQLite via sqlc v1.30, Vanilla JS SPA

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `api/sql/schema.sql` | Add `blog_secrets` DDL |
| Modify | `api/sql/queries.sql` | Add `GetSecret`, `UpsertSecret` queries |
| Regenerate | `api/internal/models/` | sqlc output — do not edit |
| Modify | `api/internal/services/settings_service.go` | Add 4 secret methods |
| Modify | `api/internal/services/settings_service_test.go` | Tests for new methods |
| Modify | `api/cmd/api/main.go` | Migrations, startup reorder, remove old functions |
| Modify | `api/internal/api/settings.go` | Rewrite 3 handlers, delete `maskGeminiAPIKey` |
| Modify | `api/internal/api/settings_test.go` | Update for new API shape |
| Modify | `api/internal/api/system.go` | Drop `mediaImportPath` field, use secrets service |
| Modify | `api/internal/services/media_service.go` | `GetSecret` for key, remove HTTP fallback |
| Modify | `api/internal/services/media_service_test.go` | Rewrite `TestMediaService_AnalyzeImage` |
| Modify | `api/internal/services/media_files_test.go` | Delete 2 HTTP-path tests |
| Modify | `frontend/src/pages/light/SettingsPage.js` | Rename `GEMINI_API_KEY` → `gemini_api_key` |

---

## Task 1: Add `blog_secrets` to schema and queries, regenerate sqlc

**Files:**
- Modify: `api/sql/schema.sql`
- Modify: `api/sql/queries.sql`
- Regenerate: `api/internal/models/` (via `sqlc generate`)

- [ ] **Step 1: Add `blog_secrets` table to schema**

  In `api/sql/schema.sql`, after the `blog_settings` table block, add:

  ```sql
  CREATE TABLE IF NOT EXISTS blog_secrets (
      key        VARCHAR(100) PRIMARY KEY,
      value      TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  ```

- [ ] **Step 2: Add sqlc queries for secrets**

  In `api/sql/queries.sql`, after the `-- SETTINGS` block, add:

  ```sql
  -- SECRETS

  -- name: GetSecret :one
  SELECT key, value, updated_at FROM blog_secrets WHERE key = ? LIMIT 1;

  -- name: UpsertSecret :exec
  INSERT INTO blog_secrets (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
  ```

- [ ] **Step 3: Regenerate sqlc**

  ```bash
  cd /home/light/src/blog/point/api && sqlc generate
  ```

  Expected: no errors, new `BlogSecret` model and `GetSecret`/`UpsertSecret` methods appear in `internal/models/`.

- [ ] **Step 4: Verify build**

  ```bash
  cd /home/light/src/blog/point/api && go build ./...
  ```

  Expected: exits 0, no errors.

- [ ] **Step 5: Commit**

  ```bash
  cd /home/light/src/blog/point
  git add api/sql/schema.sql api/sql/queries.sql api/internal/models/
  git commit -m "feat: add blog_secrets table to schema and sqlc queries"
  ```

---

## Task 2: SettingsService secret methods

**Files:**
- Modify: `api/internal/services/settings_service.go`
- Modify: `api/internal/services/settings_service_test.go`

- [ ] **Step 1: Write failing tests**

  Append to `api/internal/services/settings_service_test.go`:

  ```go
  func TestSettingsService_Secrets(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	svc := NewSettingsService(repo)
  	ctx := context.Background()

  	// SetSecret / GetSecret round-trip.
  	if err := svc.SetSecret(ctx, "gemini_api_key", "abc123"); err != nil {
  		t.Fatalf("SetSecret: %v", err)
  	}
  	val, err := svc.GetSecret(ctx, "gemini_api_key")
  	if err != nil {
  		t.Fatalf("GetSecret: %v", err)
  	}
  	if val != "abc123" {
  		t.Errorf("expected abc123, got %q", val)
  	}

  	// SecretIsSet returns true when value is non-empty.
  	if !svc.SecretIsSet(ctx, "gemini_api_key") {
  		t.Error("SecretIsSet should be true")
  	}

  	// SecretIsSet returns false for unknown key.
  	if svc.SecretIsSet(ctx, "no_such_key") {
  		t.Error("SecretIsSet should be false for missing key")
  	}

  	// GetSecret on missing key returns empty string, not error.
  	missing, err := svc.GetSecret(ctx, "no_such_key")
  	if err == nil && missing != "" {
  		t.Errorf("expected empty for missing key, got %q", missing)
  	}

  	// Upsert overwrites.
  	_ = svc.SetSecret(ctx, "gemini_api_key", "new_val")
  	v2, _ := svc.GetSecret(ctx, "gemini_api_key")
  	if v2 != "new_val" {
  		t.Errorf("expected new_val after upsert, got %q", v2)
  	}
  }

  func TestSettingsService_EnsureSecretKey_Generate(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	svc := NewSettingsService(repo)
  	ctx := context.Background()

  	cfg := &config.Config{} // SecretKey is empty
  	if err := svc.EnsureSecretKey(ctx, cfg); err != nil {
  		t.Fatalf("EnsureSecretKey: %v", err)
  	}
  	if cfg.SecretKey == "" {
  		t.Error("expected cfg.SecretKey to be populated")
  	}
  	if len(cfg.SecretKey) != 64 { // 32 bytes → 64 hex chars
  		t.Errorf("expected 64-char key, got %d", len(cfg.SecretKey))
  	}
  	// Persisted in blog_secrets.
  	stored, _ := svc.GetSecret(ctx, "_secret_key")
  	if stored != cfg.SecretKey {
  		t.Error("stored key does not match cfg.SecretKey")
  	}
  }

  func TestSettingsService_EnsureSecretKey_LoadExisting(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	svc := NewSettingsService(repo)
  	ctx := context.Background()

  	_ = svc.SetSecret(ctx, "_secret_key", "existing_key_value")

  	cfg := &config.Config{}
  	if err := svc.EnsureSecretKey(ctx, cfg); err != nil {
  		t.Fatalf("EnsureSecretKey: %v", err)
  	}
  	if cfg.SecretKey != "existing_key_value" {
  		t.Errorf("expected existing_key_value, got %q", cfg.SecretKey)
  	}
  }

  func TestSettingsService_EnsureSecretKey_EnvWins(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	svc := NewSettingsService(repo)
  	ctx := context.Background()

  	cfg := &config.Config{SecretKey: "env_key"}
  	if err := svc.EnsureSecretKey(ctx, cfg); err != nil {
  		t.Fatalf("EnsureSecretKey: %v", err)
  	}
  	if cfg.SecretKey != "env_key" {
  		t.Errorf("env key should win, got %q", cfg.SecretKey)
  	}
  }
  ```

  Add `"point-api/internal/config"` to the import block in the test file.

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  cd /home/light/src/blog/point/api && go test ./internal/services/ -run TestSettingsService_Secrets -v
  ```

  Expected: compile error — `GetSecret`, `SetSecret`, etc. not defined.

- [ ] **Step 3: Implement the four new methods in `settings_service.go`**

  Add the following imports to `settings_service.go`: `"crypto/rand"`, `"encoding/hex"`, `"fmt"`, `"log"`, `"point-api/internal/config"`.

  Append to `api/internal/services/settings_service.go` (after existing methods):

  ```go
  func (s *SettingsService) GetSecret(ctx context.Context, key string) (string, error) {
  	row, err := s.repo.GetSecret(ctx, key)
  	if err != nil {
  		return "", err
  	}
  	if !row.Value.Valid {
  		return "", nil
  	}
  	return row.Value.String, nil
  }

  func (s *SettingsService) SetSecret(ctx context.Context, key, value string) error {
  	return s.repo.UpsertSecret(ctx, models.UpsertSecretParams{
  		Key:   key,
  		Value: sql.NullString{String: value, Valid: true},
  	})
  }

  func (s *SettingsService) SecretIsSet(ctx context.Context, key string) bool {
  	val, err := s.GetSecret(ctx, key)
  	return err == nil && val != ""
  }

  // EnsureSecretKey guarantees cfg.SecretKey is populated. If SECRET_KEY is
  // absent from the environment it loads the persisted key from blog_secrets,
  // generating and storing a new 32-byte random key if none exists yet.
  func (s *SettingsService) EnsureSecretKey(ctx context.Context, cfg *config.Config) error {
  	if cfg.SecretKey != "" {
  		return nil
  	}
  	existing, err := s.GetSecret(ctx, "_secret_key")
  	if err == nil && existing != "" {
  		cfg.SecretKey = existing
  		log.Printf("loaded secret key from database secrets")
  		return nil
  	}
  	raw := make([]byte, 32)
  	if _, err := rand.Read(raw); err != nil {
  		return fmt.Errorf("generate secret key: %w", err)
  	}
  	key := hex.EncodeToString(raw)
  	if err := s.SetSecret(ctx, "_secret_key", key); err != nil {
  		return fmt.Errorf("store secret key: %w", err)
  	}
  	cfg.SecretKey = key
  	log.Printf("generated and stored new secret key in database secrets")
  	return nil
  }
  ```

- [ ] **Step 4: Run all service tests**

  ```bash
  cd /home/light/src/blog/point/api && go test ./internal/services/ -v 2>&1 | tail -20
  ```

  Expected: all tests pass, including the four new ones.

- [ ] **Step 5: Commit**

  ```bash
  cd /home/light/src/blog/point
  git add api/internal/services/settings_service.go api/internal/services/settings_service_test.go
  git commit -m "feat: add GetSecret, SetSecret, SecretIsSet, EnsureSecretKey to SettingsService"
  ```

---

## Task 3: Startup migrations and sequence update in `main.go`

**Files:**
- Modify: `api/cmd/api/main.go`
- Modify: `api/internal/api/system.go`

- [ ] **Step 1: Add five migrations to the slice in `main.go`**

  In `main.go`, append to the `migrations` slice (after the existing `"add_scheduled_at_to_posts_index"` entry, before the closing `}`):

  ```go
  {
  	"create_blog_secrets_table",
  	`CREATE TABLE IF NOT EXISTS blog_secrets (
  		key        VARCHAR(100) PRIMARY KEY,
  		value      TEXT,
  		updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  	)`,
  },
  {
  	"migrate_gemini_key_to_secrets",
  	`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
  	 SELECT 'gemini_api_key', value, updated_at FROM blog_settings WHERE key = 'GEMINI_API_KEY'`,
  },
  {
  	"migrate_secret_key_to_secrets",
  	`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
  	 SELECT key, value, updated_at FROM blog_settings WHERE key = '_secret_key'`,
  },
  {
  	"migrate_media_import_path_to_secrets",
  	`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
  	 SELECT key, value, updated_at FROM blog_settings WHERE key = 'media_import_path'`,
  },
  {
  	"cleanup_settings_secrets_keys",
  	`DELETE FROM blog_settings WHERE key IN ('GEMINI_API_KEY', '_secret_key', 'media_import_path', 'genai_api_endpoint')`,
  },
  ```

- [ ] **Step 2: Reorder startup and replace `ensureSecretKey` with service method**

  In `main.go`'s `main()` function, find the block:

  ```go
  // Ensure a secret key is available for session signing.
  if err := ensureSecretKey(ctx, &cfg, repo); err != nil {
  	log.Fatalf("failed to ensure secret key: %v", err)
  }

  svcs := initServices(&cfg, repo)
  ```

  Replace with:

  ```go
  svcs := initServices(&cfg, repo)

  // Ensure a secret key is available for session signing.
  if err := svcs.Settings.EnsureSecretKey(ctx, &cfg); err != nil {
  	log.Fatalf("failed to ensure secret key: %v", err)
  }

  // Sync env-var secrets into blog_secrets so they're available at runtime.
  if cfg.GeminiAPIKey != "" {
  	if err := svcs.Settings.SetSecret(ctx, "gemini_api_key", cfg.GeminiAPIKey); err != nil {
  		log.Printf("warning: failed to sync gemini_api_key to secrets: %v", err)
  	}
  }
  if cfg.MediaImportPath != "" {
  	if err := svcs.Settings.SetSecret(ctx, "media_import_path", cfg.MediaImportPath); err != nil {
  		log.Printf("warning: failed to sync media_import_path to secrets: %v", err)
  	}
  }
  ```

- [ ] **Step 3: Delete the standalone `ensureSecretKey` function**

  Remove the entire `ensureSecretKey` function (lines 42–79 in the current file). Also remove the now-unused imports: `"database/sql"`, `"point-api/internal/models"` (verify no other usages before removing).

- [ ] **Step 4: Update `NewSystemHandler` — drop `mediaImportPath` param**

  In `api/internal/api/system.go`, find the `SystemHandler` struct definition and remove the `mediaImportPath string` field.

  Find `NewSystemHandler` and remove `mediaImportPath string` from its parameter list and the struct initializer line `mediaImportPath: mediaImportPath,`.

  In `GetStats`, replace:
  ```go
  "import_configured": h.mediaImportPath != "",
  ```
  with:
  ```go
  "import_configured": h.settingsService.SecretIsSet(ctx, "media_import_path"),
  ```

  In `ScanMediaImport`, replace:
  ```go
  importPath := h.mediaImportPath
  ```
  with:
  ```go
  importPath, _ := h.settingsService.GetSecret(ctx, "media_import_path")
  ```

- [ ] **Step 5: Update `NewSystemHandler` call in `main.go`**

  Find:
  ```go
  systemHandler := api.NewSystemHandler(repo, svcs.Media, svcs.Post, svcs.Settings, svcs.Tag, svcs.System, svcs.Cache, cfg.StoragePath, cfg.AppVersion, cfg.MediaImportPath)
  ```

  Replace with:
  ```go
  systemHandler := api.NewSystemHandler(repo, svcs.Media, svcs.Post, svcs.Settings, svcs.Tag, svcs.System, svcs.Cache, cfg.StoragePath, cfg.AppVersion)
  ```

- [ ] **Step 6: Verify build**

  ```bash
  cd /home/light/src/blog/point/api && go build ./...
  ```

  Expected: exits 0.

- [ ] **Step 7: Commit**

  ```bash
  cd /home/light/src/blog/point
  git add api/cmd/api/main.go api/internal/api/system.go
  git commit -m "feat: add secrets migrations, reorder startup, drop mediaImportPath from SystemHandler"
  ```

---

## Task 4: Settings handler rewrite

**Files:**
- Modify: `api/internal/api/settings.go`
- Modify: `api/internal/api/settings_test.go`

- [ ] **Step 1: Write failing tests**

  Replace the content of `api/internal/api/settings_test.go` with:

  ```go
  package api

  import (
  	"bytes"
  	"context"
  	"encoding/json"
  	"net/http"
  	"net/http/httptest"
  	"testing"

  	"github.com/labstack/echo/v4"
  	"point-api/internal/services"
  )

  func TestSettingsHandler_GetPublicSettings(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	ctx := context.Background()

  	svc := services.NewSettingsService(repo)
  	_ = svc.SetSetting(ctx, "blog_title", "Test Blog", "string")
  	h := NewSettingsHandler(svc)
  	e := echo.New()

  	req := httptest.NewRequest(http.MethodGet, "/settings/public", nil)
  	rec := httptest.NewRecorder()
  	if err := h.GetPublicSettings(e.NewContext(req, rec)); err != nil {
  		t.Fatalf("GetPublicSettings: %v", err)
  	}
  	var res map[string]string
  	_ = json.Unmarshal(rec.Body.Bytes(), &res)
  	if res["blog_title"] != "Test Blog" {
  		t.Errorf("expected Test Blog, got %q", res["blog_title"])
  	}
  }

  func TestSettingsHandler_GetSettings_SecretKeysAbsent(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	ctx := context.Background()

  	svc := services.NewSettingsService(repo)
  	// Store a secret — it must never appear in the response.
  	_ = svc.SetSecret(ctx, "_secret_key", "super_secret")
  	_ = svc.SetSecret(ctx, "gemini_api_key", "gkey")
  	_ = svc.SetSetting(ctx, "blog_title", "My Blog", "string")

  	h := NewSettingsHandler(svc)
  	e := echo.New()
  	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
  	rec := httptest.NewRecorder()
  	if err := h.GetSettings(e.NewContext(req, rec)); err != nil {
  		t.Fatalf("GetSettings: %v", err)
  	}
  	if rec.Code != http.StatusOK {
  		t.Fatalf("expected 200, got %d", rec.Code)
  	}

  	var res map[string]string
  	_ = json.Unmarshal(rec.Body.Bytes(), &res)

  	if _, ok := res["_secret_key"]; ok {
  		t.Error("_secret_key must not appear in settings response")
  	}
  	if _, ok := res["gemini_api_key"]; ok {
  		t.Error("gemini_api_key value must not appear in settings response")
  	}
  	if res["gemini_api_key_is_set"] != "true" {
  		t.Errorf("gemini_api_key_is_set should be true, got %q", res["gemini_api_key_is_set"])
  	}
  	if res["media_import_path_is_set"] != "false" {
  		t.Errorf("media_import_path_is_set should be false, got %q", res["media_import_path_is_set"])
  	}
  	if res["blog_title"] != "My Blog" {
  		t.Errorf("blog_title should be My Blog, got %q", res["blog_title"])
  	}
  }

  func TestSettingsHandler_UpdateSettings_SecretRouted(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	ctx := context.Background()

  	svc := services.NewSettingsService(repo)
  	h := NewSettingsHandler(svc)
  	e := echo.New()

  	body, _ := json.Marshal(map[string]string{"gemini_api_key": "new_key", "blog_title": "Updated"})
  	req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader(body))
  	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
  	rec := httptest.NewRecorder()
  	if err := h.UpdateSettings(e.NewContext(req, rec)); err != nil {
  		t.Fatalf("UpdateSettings: %v", err)
  	}

  	var res map[string]string
  	_ = json.Unmarshal(rec.Body.Bytes(), &res)

  	// Secret value never returned.
  	if _, ok := res["gemini_api_key"]; ok {
  		t.Error("gemini_api_key value must not appear in update response")
  	}
  	// Synthetic flag present.
  	if res["gemini_api_key_is_set"] != "true" {
  		t.Errorf("expected gemini_api_key_is_set=true, got %q", res["gemini_api_key_is_set"])
  	}
  	// Normal setting updated.
  	if res["blog_title"] != "Updated" {
  		t.Errorf("expected blog_title=Updated, got %q", res["blog_title"])
  	}
  	// Value written to secrets table.
  	val, _ := svc.GetSecret(ctx, "gemini_api_key")
  	if val != "new_key" {
  		t.Errorf("expected secret new_key, got %q", val)
  	}
  }

  func TestSettingsHandler_GetSettingByKey(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()
  	ctx := context.Background()

  	svc := services.NewSettingsService(repo)
  	_ = svc.SetSetting(ctx, "my_key", "my_value", "string")
  	h := NewSettingsHandler(svc)
  	e := echo.New()

  	req := httptest.NewRequest(http.MethodGet, "/settings/my_key", nil)
  	rec := httptest.NewRecorder()
  	c := e.NewContext(req, rec)
  	c.SetParamNames("key")
  	c.SetParamValues("my_key")
  	if err := h.GetSettingByKey(c); err != nil {
  		t.Fatalf("GetSettingByKey: %v", err)
  	}
  	if rec.Code != http.StatusOK {
  		t.Errorf("expected 200, got %d", rec.Code)
  	}
  }

  func TestUpdateSettings_InvalidBind(t *testing.T) {
  	repo := setupTestDB(t)
  	defer func() { _ = repo.Close() }()

  	svc := services.NewSettingsService(repo)
  	h := NewSettingsHandler(svc)
  	e := echo.New()

  	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte(`"not_an_object"`)))
  	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
  	rec := httptest.NewRecorder()
  	if err := h.UpdateSettings(e.NewContext(req, rec)); err == nil {
  		t.Error("expected bind error")
  	}
  }
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  cd /home/light/src/blog/point/api && go test ./internal/api/ -run TestSettingsHandler -v 2>&1 | tail -20
  ```

  Expected: failures on the new secret-related assertions.

- [ ] **Step 3: Rewrite `api/internal/api/settings.go`**

  Replace the entire file content with:

  ```go
  package api

  import (
  	"net/http"
  	"strconv"

  	"github.com/labstack/echo/v4"
  	"point-api/internal/services"
  )

  type SettingsHandler struct {
  	settingsService *services.SettingsService
  }

  func NewSettingsHandler(settingsService *services.SettingsService) *SettingsHandler {
  	return &SettingsHandler{settingsService: settingsService}
  }

  // publicSettingKeys are settings safe to expose to unauthenticated users.
  var publicSettingKeys = map[string]bool{
  	"blog_title":              true,
  	"blog_subtitle":           true,
  	"author_name":             true,
  	"posts_per_page":          true,
  	"default_language":        true,
  	"default_theme":           true,
  	"show_view_counts":        true,
  	"enable_analytics":        true,
  	"google_analytics_id":     true,
  	"use_thumbnails":          true,
  	"about_post_id":           true,
  	"multi_user_mode":         true,
  	"show_tag_cloud":          true,
  	"enable_map":              true,
  	"enable_backup":           true,
  	"immersive_nav_direction": true,
  	"exif_visibility":         true,
  }

  // writableSecretKeys are secrets the admin may set through the API.
  // Values are routed to blog_secrets and never returned in responses.
  var writableSecretKeys = map[string]bool{
  	"gemini_api_key": true,
  }

  func (h *SettingsHandler) GetPublicSettings(c echo.Context) error {
  	all, err := h.settingsService.GetAllSettings(c.Request().Context())
  	if err != nil {
  		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
  	}
  	public := make(map[string]string)
  	for k, v := range all {
  		if publicSettingKeys[k] {
  			public[k] = v
  		}
  	}
  	return c.JSON(http.StatusOK, public)
  }

  func (h *SettingsHandler) GetSettings(c echo.Context) error {
  	ctx := c.Request().Context()
  	all, err := h.settingsService.GetAllSettings(ctx)
  	if err != nil {
  		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
  	}
  	all["gemini_api_key_is_set"] = strconv.FormatBool(h.settingsService.SecretIsSet(ctx, "gemini_api_key"))
  	all["media_import_path_is_set"] = strconv.FormatBool(h.settingsService.SecretIsSet(ctx, "media_import_path"))
  	return c.JSON(http.StatusOK, all)
  }

  func (h *SettingsHandler) GetSettingByKey(c echo.Context) error {
  	ctx := c.Request().Context()
  	key := c.Param("key")
  	value, err := h.settingsService.GetSetting(ctx, key, "")
  	if err != nil {
  		return echo.NewHTTPError(http.StatusNotFound, "setting not found")
  	}
  	return c.JSON(http.StatusOK, map[string]string{"key": key, "value": value})
  }

  func (h *SettingsHandler) UpdateSettings(c echo.Context) error {
  	ctx := c.Request().Context()
  	var updates map[string]string
  	if err := c.Bind(&updates); err != nil {
  		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
  	}

  	for key, value := range updates {
  		if writableSecretKeys[key] {
  			if err := h.settingsService.SetSecret(ctx, key, value); err != nil {
  				return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
  			}
  			continue
  		}
  		if err := h.settingsService.SetSetting(ctx, key, value, "string"); err != nil {
  			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
  		}
  	}

  	all, err := h.settingsService.GetAllSettings(ctx)
  	if err != nil {
  		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
  	}
  	all["gemini_api_key_is_set"] = strconv.FormatBool(h.settingsService.SecretIsSet(ctx, "gemini_api_key"))
  	all["media_import_path_is_set"] = strconv.FormatBool(h.settingsService.SecretIsSet(ctx, "media_import_path"))
  	return c.JSON(http.StatusOK, all)
  }
  ```

- [ ] **Step 4: Run tests**

  ```bash
  cd /home/light/src/blog/point/api && go test ./internal/api/ -v 2>&1 | tail -20
  ```

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  ```bash
  cd /home/light/src/blog/point
  git add api/internal/api/settings.go api/internal/api/settings_test.go
  git commit -m "feat: rewrite settings handlers — secrets never in API responses"
  ```

---

## Task 5: Remove `genai_api_endpoint` dead code

**Files:**
- Modify: `api/internal/services/media_service.go`
- Modify: `api/internal/services/media_service_test.go`
- Modify: `api/internal/services/media_files_test.go`

- [ ] **Step 1: Update `AnalyzeImage` — use secrets, remove HTTP fallback**

  In `api/internal/services/media_service.go`, find the `AnalyzeImage` function.

  Change line:
  ```go
  apiKey, _ := s.settingsService.GetSetting(ctx, "GEMINI_API_KEY", "")
  ```
  to:
  ```go
  apiKey, _ := s.settingsService.GetSecret(ctx, "gemini_api_key")
  ```

  Remove the `else` branch that reads `genai_api_endpoint` and calls `analyzeImageViaHTTP`. Replace it with:

  ```go
  } else {
  	log.Printf("warning: AI features disabled (gemini_api_key is absent)")
  	return &AnalysisResponse{Tags: []string{}}, nil
  }
  ```

  So the full condition block becomes:
  ```go
  if apiKey != "" && len(s.genaiConfig.Models) > 0 {
  	client, initErr := genai.NewClient(ctx, &genai.ClientConfig{
  		APIKey:  apiKey,
  		Backend: genai.BackendGeminiAPI,
  	})
  	if initErr == nil {
  		analysis, err = s.analyzeImageDirectlyWithClient(ctx, client, content, filename, mimeType)
  	} else {
  		err = initErr
  	}
  } else if s.genaiClient != nil && len(s.genaiConfig.Models) > 0 {
  	analysis, err = s.analyzeImageDirectlyWithClient(ctx, s.genaiClient, content, filename, mimeType)
  } else {
  	log.Printf("warning: AI features disabled (gemini_api_key is absent)")
  	return &AnalysisResponse{Tags: []string{}}, nil
  }
  ```

- [ ] **Step 2: Delete `analyzeImageViaHTTP` method**

  Remove the entire `func (s *MediaService) analyzeImageViaHTTP(...)` method from `media_service.go`. Also remove any imports that were only used by it (verify: `"io"`, `"net/http"`, `"encoding/json"` — check if still used elsewhere before removing).

- [ ] **Step 3: Rewrite `TestMediaService_AnalyzeImage` in `media_service_test.go`**

  The existing test relies on the HTTP path. Replace it entirely:

  ```go
  func TestMediaService_AnalyzeImage_DisabledWithNoKey(t *testing.T) {
  	service, tmpDir := setupMediaService(t)
  	defer func() {
  		_ = os.RemoveAll(tmpDir)
  		_ = service.repo.Close()
  	}()
  	ctx := context.Background()

  	// No API key → analysis is a no-op returning empty tags.
  	img := image.NewRGBA(image.Rect(0, 0, 5, 5))
  	var buf bytes.Buffer
  	_ = jpeg.Encode(&buf, img, nil)

  	result, err := service.AnalyzeImage(ctx, buf.Bytes(), "test.jpg", "image/jpeg")
  	if err != nil {
  		t.Fatalf("expected no error when key absent, got: %v", err)
  	}
  	if result == nil || len(result.Tags) != 0 {
  		t.Error("expected empty analysis response when key absent")
  	}
  }
  ```

  Clean up the now-unused imports in `media_service_test.go` (remove `"encoding/json"`, `"net/http"`, `"net/http/httptest"` if no longer used).

- [ ] **Step 4: Delete two tests from `media_files_test.go`**

  Remove the entire `TestMediaService_AnalyzeImageViaHTTP` function (lines 567–599) and `TestMediaService_AnalyzeImageViaHTTPError` function (lines 601–628) from `api/internal/services/media_files_test.go`.

  Also remove `genai_api_endpoint` `SetSetting` call from `TestMediaService_AnalyzeImage` if any remnant exists in that file.

- [ ] **Step 5: Run all service tests**

  ```bash
  cd /home/light/src/blog/point/api && go test ./internal/services/ -v 2>&1 | tail -30
  ```

  Expected: all pass, no references to `analyzeImageViaHTTP` or `genai_api_endpoint`.

- [ ] **Step 6: Run full test suite**

  ```bash
  cd /home/light/src/blog/point && ./scripts/run-tests.sh
  ```

  Expected: all pass.

- [ ] **Step 7: Commit**

  ```bash
  cd /home/light/src/blog/point
  git add api/internal/services/media_service.go api/internal/services/media_service_test.go api/internal/services/media_files_test.go
  git commit -m "feat: remove genai_api_endpoint dead code, use gemini_api_key secret"
  ```

---

## Task 6: Frontend — rename `GEMINI_API_KEY` to `gemini_api_key`

**Files:**
- Modify: `frontend/src/pages/light/SettingsPage.js`

- [ ] **Step 1: Update `SETTING_GROUPS` AI section**

  In `frontend/src/pages/light/SettingsPage.js`, find:

  ```js
  keys: ['GEMINI_API_KEY', 'gemini_prompt_title', 'gemini_prompt_tags', 'gemini_prompt_excerpt']
  ```

  Replace with:

  ```js
  keys: ['gemini_api_key', 'gemini_prompt_title', 'gemini_prompt_tags', 'gemini_prompt_excerpt']
  ```

- [ ] **Step 2: Update the password field renderer**

  Find:
  ```js
  } else if (key === 'GEMINI_API_KEY') {
    const isConfigured = settings['GEMINI_API_KEY_CONFIGURED'] === 'true' || settings['GEMINI_API_KEY_CONFIGURED'] === true;
    const placeholder = isConfigured ? '******** (Configured)' : 'Enter Gemini API Key';
    input = `<input type="password" name="${key}" id="${key}" class="form-input" placeholder="${placeholder}" value="">`;
  ```

  Replace with:
  ```js
  } else if (key === 'gemini_api_key') {
    const isConfigured = settings['gemini_api_key_is_set'] === 'true' || settings['gemini_api_key_is_set'] === true;
    const placeholder = isConfigured ? '******** (Configured)' : 'Enter Gemini API Key';
    input = `<input type="password" name="${key}" id="${key}" class="form-input" placeholder="${placeholder}" value="">`;
  ```

- [ ] **Step 3: Update form submission guard**

  Find:
  ```js
  if (k === 'GEMINI_API_KEY') {
    if (val) data[k] = val;
    return;
  }
  ```

  Replace with:
  ```js
  if (k === 'gemini_api_key') {
    if (val) data[k] = val;
    return;
  }
  ```

- [ ] **Step 4: Commit**

  ```bash
  cd /home/light/src/blog/point
  git add frontend/src/pages/light/SettingsPage.js
  git commit -m "feat: rename GEMINI_API_KEY to gemini_api_key in frontend settings"
  ```

---

## Final Check

- [ ] **Run full test suite**

  ```bash
  cd /home/light/src/blog/point && ./scripts/run-tests.sh
  ```

  Expected: all pass.

- [ ] **Verify build**

  ```bash
  cd /home/light/src/blog/point/api && go build ./...
  ```

  Expected: exits 0.

- [ ] **Push to remote**

  ```bash
  cd /home/light/src/blog/point
  git pull --rebase
  bd dolt push
  git push
  ```
