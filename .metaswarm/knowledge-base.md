# Point — Metaswarm Knowledge Base

## Project Identity
- **Name**: Point — self-hosted personal photo blog engine
- **Stack**: Go 1.25 + Echo v4 · SQLite/sqlc · Vanilla JS SPA · Podman
- **Auth**: Session-cookie (bcrypt) · no JWT
- **AI**: Google Gemini (`api/data.yml`) · endpoint `POST /api/media/analyze`

## Architecture Layers
```
Handler (internal/api/)
  → Service (internal/services/)
    → Repository (internal/repository/)
      → sqlc models (internal/models/)  ← auto-generated, never edit
```

## Critical Rules
1. Never edit `api/internal/models/` — sqlc-generated; edit `api/sql/queries.sql` then `sqlc generate`
2. Never edit CSS bundle files directly — edit modules in `frontend/css/` then run `./scripts/build-css.sh`
3. DB migrations live in `api/cmd/api/main.go` (inline slice), not in `api/migrations/` (empty)
4. Container engine is **Podman** in dev, Docker in prod
5. No frontend build step — JS changes are live immediately
6. Branch names must start with `claude/` for push permissions

## Test Commands
```bash
./scripts/run-tests.sh            # standard run (80% coverage required)
./scripts/run-tests.sh --verbose  # verbose output
./scripts/run-tests.sh --race     # race detector
./scripts/run-tests.sh --html     # generates api/coverage.html
```

## Adding an Endpoint (checklist)
1. Add query to `api/sql/queries.sql`
2. Run `cd api && sqlc generate`
3. Add repository method (hand-written SQL → `api/internal/repository/extended.go`)
4. Implement service in `api/internal/services/`
5. Add handler in `api/internal/api/`
6. Register route in `api/cmd/api/main.go`
7. Write `*_test.go` alongside handler/service

## Error Response Shape
```go
return echo.NewHTTPError(http.StatusNotFound, "post not found")
// or:
return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
```

## Frontend Patterns
- New page: `src/pages/{light|public}/MyPage.js` → export `render(params)` → register in `src/router.js`
- New API module: `src/api/myresource.js` wrapping `client.js` helpers
- New component: `src/components/{light|public|shared}/MyComponent.js` extending `Component`

## Known CI Workflows
- `.github/workflows/test.yml` — Go tests
- `.github/workflows/deploy.yml` — container build + deploy

## External Tools Available
- `gemini` CLI — available for adversarial review and parallel agent tasks
- `codex` — not available
