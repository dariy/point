# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

---


## 2026-10-05 - p-j3i6
- Added a `scope` to API keys: `general` (full access) and `lightroom` (create-only).
- A lightroom key may only POST `/api/posts`, `/api/tags`, `/api/media/upload` and `/api/media/upload/multiple`. Other routes answer 403. On OptionalAuth reads it gets the guest view. The MCP path accepts only general keys.
- Files: api/sql/{schema,queries}.sql, api/internal/migrations/migrations.go (`add_api_keys_scope`), api/internal/models (sqlc regen), services/apikey_service.go, api/{middleware,apikeys,mappers}.go, mcp/server.go, cmd/api/apikey.go, tests, frontend api/auth.ts + ApiKeysSection.ts, docs/features/auth.md.
- **Learnings:**
  - Three callers reach `ValidateAPIKey` (AuthMiddleware, OptionalAuth, MCP). Each needs its own scope check.
  - `c.Path()` gives the route pattern, so scope checks match registered routes, not raw URLs.
  - A duplicate-column error in a migration counts as a no-op, so a new column can go in both schema.sql and the migration list.
---
