# Go Test Coverage Design — 90%+

**Date:** 2026-03-03
**Branch:** experiment-go
**Current coverage:** 40.9% overall

---

## Goal

Bring Go unit test coverage from ~41% to **90%+** across all hand-written packages (excluding sqlc-generated models and cmd entry points).

## Scope

### Included packages (targets)

| Package | Current | Target |
|---|---|---|
| `internal/api` | 53.5% | 90%+ |
| `internal/services` | 39.5% | 90%+ |
| `internal/repository` | 31.4% | 90%+ |
| `internal/config` | 93.8% | 95%+ |
| `internal/utils` | 100% | 100% ✅ |

### Excluded (justified)

- `cmd/api/main.go` — entry point, no clean test seam
- `cmd/migrate-paths/main.go` — utility entry point
- `internal/models/` — sqlc-generated, not hand-written

---

## Approach: Extend Existing Test Files

Use the established pattern:
- **Real in-memory SQLite** via `setupTestDB(t)` (`:memory:`)
- **Real services** wired on top of the repository
- **Echo + httptest** for handler testing
- **`net/http/httptest.NewServer`** to mock Gemini HTTP endpoint

No interface extraction or handler refactoring required. All new tests added to existing `*_test.go` files, plus two new files.

---

## Files to Create/Extend

### New files
1. `internal/api/util_test.go` — coord parsing pure functions + `ParseMapsCoords` with mock HTTP server
2. `internal/api/mappers_test.go` — all mapper helpers

### Extend existing files
3. `internal/api/auth_test.go` — `ChangePassword`, `DeleteSession`
4. `internal/api/media_test.go` — `GetMediaFolders`, `GetMedia`, `UpdateMedia`, `ListOrphanedMedia`, `DeleteMedia`, `UploadMultiple`, `RenameMedia`
5. `internal/api/posts_test.go` — `UpdatePostTags`, `GetPostNavigation`
6. `internal/api/settings_test.go` — `GetSettings`, `GetSettingByKey`
7. `internal/api/system_test.go` — `GetMigrations`, `RecalculateMediaVisibility`, `UpdateMapCoords`
8. `internal/api/tags_test.go` — `GetTagBySlug`, `UpdateTag`, `ReorderTag`, `GetPostsByTag`
9. `internal/api/pages_test.go` — `GetMapPage`
10. `internal/services/post_service_test.go` — `GetPostBySlug`, `UpdatePostTags`, `PublishPost`, `WithdrawPost`, `GetPostNavigation`, `preprocessContent`
11. `internal/services/media_service_test.go` — `BulkDeleteMedia`, `GetMediaFolders`, `AnalyzeMediaByPath` (mock HTTP), `ExtractMediaPaths`, `UpdateMediaVisibilityForPaths`, `RecalculateAllMediaVisibility`, `parseAnalysisResult`
12. `internal/services/tag_service_test.go` — `GetTagChildren`, `SetTagParents`, `SetTagChildren`, `ReorderTag`, `SetTagLocations`, `GetTagsByPostIDs`, `buildEffectivelyHiddenIDs`, `EffectivelyHiddenIDs`, `GetHierarchicalNavTags`, `GetPostsByTag`
13. `internal/repository/extended_test.go` — `ListPostsWithSearch`, `CountPostsWithSearch`, `GetPublishedPostsForFeed`, `GetPostByPreviewToken`, `GetPostNavigation`, `GetAllTagRelationships`, `ClearTagParents/Children`, `ListOrphanedMediaByPage`, `ListMediaFolders`, `ListMediaFiltered`, `CountMediaFiltered`, `GetTagsByPostIDs`, `GetYearTagsByLocationTagIDs`, `GetChildrenOfTag`, `GetRootTags`, `UpdateTagSortOrder`, `GetPostsByTagIDs`, `CountPostsByTagIDs`, `GetMediaByPath`, `SetMediaPublic`, `GetHierarchicalPostCounts`, `GetAllPublishedPostContents`, `GetAllMediaPaths`, `ApplyMigration`

---

## Deliberately Excluded Code Paths

These require live external services and are marked in code comments:

- `analyzeImageDirectly` — calls Gemini Go SDK directly, no HTTP interception
- Short link resolution (redirects to `maps.app.goo.gl`) — tested by documenting as requiring live HTTP
- `GeocodeTag` — makes live geocoding HTTP request

---

## Test Conventions

- Use `t.Helper()` on shared setup functions
- Table-driven tests for pure functions with multiple cases
- Single setup + multiple scenarios for handler tests (reduces DB setup overhead)
- Error paths (invalid JSON, missing params, not found) always included
- Use `if rec.Code != http.StatusXXX` assertions (consistent with existing tests)
