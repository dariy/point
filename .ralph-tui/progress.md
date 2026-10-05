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

## 2026-10-05 - p-carousel-touch-layout-vfs1
- This bead is the S10 epic. All nine children (.1 to .9) were already closed. I made no code change.
- The S10 code is on branch `carousel-studio`, not on `ts-tests`. I found `createMultiTapWatcher` and `isTouchLayout` there.
- I closed the epic.
- **Learnings:**
  - Run `br show <id>` first. If the type is epic, check the children before any work.
  - Carousel work lives on `carousel-studio`. `frontend/src/plugins/carousel` does not exist on other branches.
---
## 2026-10-05 - p-7181
- Made TestSystemService_CreateBackup_InsufficientDisk deterministic: sparse file is Free+1TiB; Truncate/Create errors are checked (skip if the filesystem refuses).
- Files changed: api/internal/api/system_test.go
- **Learnings:**
  - A margin of +1 byte over a sampled free-space value is racy on shared CI; use a margin far above any drift.
---

## 2026-10-05 - p-template-node-test-3fcc
- Replaced the `<the narrow test command>` placeholder in the `/br-new` body template with `node --test frontend/test/<File>.test.ts` and `(cd api && go test ./internal/<pkg>/...)`, plus a "no vitest, no jest" note.
- Files changed: ~/src/beads-private/point/bin/bead-new.sh (private repo).
- **Learnings:**
  - Frontend tests are now `.test.ts`; the bead's `.test.js` example no longer exists.
  - AGENTS.md "Frontend tests" row still says `*.test.js`; `package.json` globs `*.test.[jt]s`. Candidate for a follow-up bead.
---

## 2026-10-05 - p-967m
- `shouldUseImmersive` now derives media type from `path` with `mediaTypeFromPath`. The API sends no media `type`. Removed the cast and its comment.
- Files changed: frontend/src/components/public/PostContent.ts; new frontend/test/shouldUseImmersive.test.ts (audio-only, image, mixed).
- **Learnings:**
  - `PostMediaRef` has no `type`. Derive the type from `path`.
---

## 2026-10-05 - p-royn
- `ViewContext.toUrl` now keeps `/map` (and `/map/`) like `/tags`. A timeline change on `/map` stays on `/map?timeline=<from>-<to>`.
- Files changed: frontend/src/utils/viewContext.ts, frontend/test/viewContext.test.ts
- **Learnings:**
  - Any new module path with its own timeline must be added to the module check in `toUrl`, or it falls back to `/`.
---
