# Secrets Table Design

**Date:** 2026-04-22
**Status:** Approved
**Branch:** develop

## Problem

All settings — including the session signing key (`_secret_key`), Gemini API key, and media import path — live in the flat `blog_settings` table. The admin `GET /api/settings` endpoint returned all rows, relying on ad-hoc `delete()` calls and a `maskGeminiAPIKey()` helper to strip sensitive values. This approach is fragile: adding a new sensitive setting requires remembering to also add it to the blocklist. The `_secret_key` (session signing key) was missing from the blocklist entirely, making it a live security bug.

## Goal

Introduce a physically separate `blog_secrets` table. Sensitive values never enter the `blog_settings` query path, so they cannot accidentally appear in API responses. Expose only synthetic `<key>_is_set` boolean properties for secrets that have UI relevance. Remove the obsolete `genai_api_endpoint` code path.

## Out of Scope

- New secret types beyond the three identified
- Secret rotation UI
- Encryption at rest for `blog_secrets`

## Data Layer

### New table

```sql
CREATE TABLE IF NOT EXISTS blog_secrets (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

No `value_type` column — all secrets are strings.

### Secrets inventory

| DB/Go key          | env var           | API-visible synthetic     |
|--------------------|-------------------|---------------------------|
| `gemini_api_key`   | `GEMINI_API_KEY`  | `gemini_api_key_is_set`   |
| `media_import_path`| `MEDIA_IMPORT_PATH` | `media_import_path_is_set` |
| `_secret_key`      | `SECRET_KEY`      | *(none — fully invisible)* |

### Naming convention

Keys in `blog_secrets` use `snake_case`. Env vars stay `UPPER_CASE`. The startup sync maps env var → lowercase DB key. This convention extends to all future secrets.

### Startup migrations

1. Create `blog_secrets` table.
2. If `blog_settings` has a row with `key = 'GEMINI_API_KEY'`, copy its value to `blog_secrets` as `gemini_api_key` and delete the original row.
3. If `blog_settings` has a row with `key = '_secret_key'`, copy its value to `blog_secrets` and delete the original row.
4. If `blog_settings` has a row with `key = 'media_import_path'`, copy its value to `blog_secrets` and delete the original row.
5. Delete any row with `key = 'genai_api_endpoint'` from `blog_settings`.

### sqlc queries

Add to `queries.sql`:

```sql
-- name: GetSecret :one
SELECT key, value, updated_at FROM blog_secrets WHERE key = ?;

-- name: UpsertSecret :exec
INSERT INTO blog_secrets (key, value, updated_at)
VALUES (?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
```

## Service Layer

`SettingsService` gains three new methods backed by the `blog_secrets` table:

```go
GetSecret(ctx context.Context, key string) (string, error)
SetSecret(ctx context.Context, key, value string) error
SecretIsSet(ctx context.Context, key string) bool
```

`SecretIsSet` returns true if the row exists and `value != ""`.

### Env-var sync at startup

After `ensureSecretKey` runs, the startup sequence also syncs the Gemini API key from config into secrets:

```go
if cfg.GeminiAPIKey != "" {
    settingsService.SetSecret(ctx, "gemini_api_key", cfg.GeminiAPIKey)
}
```

This mirrors the existing `MEDIA_IMPORT_PATH` sync pattern.

`ensureSecretKey` in `main.go` is updated to call `settingsService.GetSecret` / `settingsService.SetSecret` instead of the raw repo methods.

### Call-site changes

| File | Before | After |
|------|--------|-------|
| `media_service.go` | `settingsService.GetSetting(ctx, "GEMINI_API_KEY", "")` | `settingsService.GetSecret(ctx, "gemini_api_key")` |
| `main.go` | `repo.GetSetting(ctx, "_secret_key")` | `settingsService.GetSecret(ctx, "_secret_key")` |
| `main.go` | `repo.UpdateSetting(ctx, {Key: "_secret_key", …})` | `settingsService.SetSecret(ctx, "_secret_key", key)` |

## API Layer

### `GET /api/settings/public`

Unchanged. `google_analytics_id` remains in `publicSettingKeys` — the frontend requires the actual value to inject the GA script.

### `GET /api/settings` (auth required)

1. Fetch all rows from `blog_settings` (secrets are never in this table post-migration).
2. Append synthetic booleans:
   - `"gemini_api_key_is_set"`: `settingsService.SecretIsSet(ctx, "gemini_api_key")`
   - `"media_import_path_is_set"`: `settingsService.SecretIsSet(ctx, "media_import_path")`
3. Return JSON.

No blocklist. No `maskGeminiAPIKey()`. No manual `delete()` calls.

### `GET /api/settings/:key` (auth required)

Blocklist removed. Secret keys are absent from `blog_settings`, so they cannot be fetched by this endpoint by construction.

### `PUT /PATCH /api/settings` (auth required)

```go
var writableSecretKeys = map[string]bool{
    "gemini_api_key": true,
}
```

Keys in `writableSecretKeys` are routed to `settingsService.SetSecret`. All other keys go to `settingsService.SetSetting`. `_secret_key` and `media_import_path` are not in `writableSecretKeys` — the API cannot write them.

Response: same shape as `GET /api/settings` (settings + `_is_set` synthetics, no secret values).

## Removals: `genai_api_endpoint`

`media_service.go` `AnalyzeImage` currently has a fallback `else` branch that reads `genai_api_endpoint` from settings and calls `analyzeImageViaHTTP`. This path is dead — direct Gemini client calls are used exclusively.

**Remove:**
- The `else` branch reading `genai_api_endpoint` in `AnalyzeImage`
- The `analyzeImageViaHTTP` method
- `TestMediaService_AnalyzeImageViaHTTP` in `media_files_test.go`
- The `genai_api_endpoint` setup in `media_service_test.go`
- Startup migration cleans the DB row (see Data Layer above)

## Frontend Changes

### `SettingsPage.js`

| Before | After |
|--------|-------|
| Key name: `GEMINI_API_KEY` | Key name: `gemini_api_key` |
| Synthetic check: `settings['GEMINI_API_KEY_CONFIGURED']` | Synthetic check: `settings['gemini_api_key_is_set']` |
| Password placeholder: `'******** (Configured)'` | Unchanged |

The `SETTING_GROUPS` AI section key changes from `'GEMINI_API_KEY'` to `'gemini_api_key'`. Form submission sends `gemini_api_key` as the key.

### System page

Add a read-only indicator for `media_import_path_is_set` alongside the existing import path hint — same style as other status indicators on that page.

## Definition of Done

- [ ] `blog_secrets` table created via startup migration
- [ ] Existing sensitive rows migrated out of `blog_settings`
- [ ] `genai_api_endpoint` row deleted from `blog_settings`
- [ ] `SettingsService.GetSecret`, `SetSecret`, `SecretIsSet` implemented and tested
- [ ] `AnalyzeImage` no longer reads `GEMINI_API_KEY` from settings; reads from secrets
- [ ] `ensureSecretKey` reads/writes `_secret_key` via secrets service
- [ ] `GetSettings` returns `_is_set` synthetics, no ad-hoc masking code remains
- [ ] `UpdateSettings` routes `gemini_api_key` writes to secrets table
- [ ] `analyzeImageViaHTTP` and its tests deleted
- [ ] Frontend uses `gemini_api_key` / `gemini_api_key_is_set` field names
- [ ] `media_import_path_is_set` indicator on System page
- [ ] All existing tests pass; new unit tests for `GetSecret`/`SetSecret`/`SecretIsSet`
