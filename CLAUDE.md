> **Last Updated**: 2026-03-03
> **Project Status**: Active Development
> **Current Phase**: Go API migration (branch: `experiment-go`)

## Project Overview

**Point** is a self-hosted personal photo blog engine. Single-container deployment, SQLite storage, no external services.

### Technology Stack

```
Backend:     Go 1.25 + Echo v4
Database:    SQLite via sqlc (type-safe SQL)
Image Proc:  disintegration/imaging
Config:      spf13/viper (.env file)
Markdown:    yuin/goldmark + goldmark-highlighting
AI:          Google Gemini (via google/genai)
Auth:        Session-cookie (bcrypt passwords)
Container:   Podman + podman-compose for development, Docker + docker-compose for production
Frontend:    Vanilla JS SPA (no build step)
CSS:         Concatenated modules (scripts/build-css.sh)
```

---

## Repository Structure

```
point/
├── api/                    # Go API server
│   ├── cmd/api/main.go     # Entry point; routes + startup migrations
│   ├── internal/
│   │   ├── api/            # HTTP handlers (Echo)
│   │   ├── services/       # Business logic
│   │   ├── repository/     # DB access (sqlc-generated + extended.go)
│   │   ├── models/         # sqlc-generated models (do not edit)
│   │   ├── config/         # Viper config loader
│   │   └── utils/          # Slug generation, helpers
│   ├── sql/
│   │   ├── schema.sql      # Source of truth for DB schema
│   │   └── queries.sql     # sqlc query definitions
│   ├── data.yml            # Gemini AI prompt + model list
│   ├── go.mod
│   └── sqlc.yaml
├── frontend/               # Vanilla JS SPA (served as static files)
│   ├── index.html          # SPA shell
│   ├── src/
│   │   ├── app.js          # Bootstrap
│   │   ├── router.js       # SPA routing
│   │   ├── store.js        # State management
│   │   ├── api/            # API client modules (one per resource)
│   │   ├── components/
│   │   │   ├── light/      # Admin UI components
│   │   │   ├── public/     # Blog UI components
│   │   │   └── shared/     # Shared UI components
│   │   ├── pages/
│   │   │   ├── light/      # Admin pages
│   │   │   └── public/     # Public blog pages
│   │   └── utils/          # helpers.js, formatters.js, tags.js, icons.js
│   └── css/
│       ├── common/         # Tokens, reset, buttons, forms, etc.
│       ├── light/          # Admin-specific styles
│       └── public/         # Blog-specific styles
├── build/
│   ├── Dockerfile          # Multi-stage Podman build
│   ├── rebuild.sh          # Build + deploy with Podman
│   └── docker-compose.yml  # podman-compose config
├── scripts/
│   ├── run-tests.sh        # Go test runner with coverage
│   └── build-css.sh        # Concatenate CSS modules → bundles
├── docs/                   # Project documentation
├── data/                   # Runtime data (DB, media) — gitignored
└── MIGRATION_PROGRESS.md   # Go migration remaining tasks
```

---

## Development Workflow

### Branch Strategy

- **Main branch**: `main` (production-ready)
- **Feature branches**: `claude/claude-md-<session-id>-<hash>`
- Branch names **must** start with `claude/` for push permissions

### Commit Messages (Conventional Commits)

```
feat: add tag coordinates update endpoint
fix: resolve thumbnail path after rename
refactor: simplify media visibility check
test: add service-level tests for auth
chore: update goldmark dependency
```

### Running the API (local dev)

```bash
cd api
# Create .env from build/.env (or let Viper use defaults)
go run ./cmd/api
# API runs on http://localhost:8000 by default
```

### Running Tests

```bash
# From project root — runs all Go tests with coverage
./scripts/run-tests.sh

# Specific package
./scripts/run-tests.sh ./internal/services/...

# Options
./scripts/run-tests.sh --verbose     # -v output
./scripts/run-tests.sh --html        # generate coverage.html in api/
./scripts/run-tests.sh --race        # enable race detector
```

### Building CSS

```bash
# From project root — concatenates css/ modules into bundles
./scripts/build-css.sh
# Outputs: frontend/css/light.bundle.css, frontend/css/public.bundle.css
```

### Building + Deploying (Podman)

```bash
cd build
./rebuild.sh          # build + restart container
./rebuild.sh --clean  # force pull base images first
```

---

## Configuration

Config is loaded from a `.env` file (in the `api/` working directory) via Viper, with env var overrides.

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `8000` | API listen port |
| `SECRET_KEY` | *(auto-generated)* | Session signing key — generated and stored in `blog_secrets` if absent |
| `DATABASE_URL` | `sqlite:./data/point.db` | SQLite path |
| `STORAGE_PATH` | `./data` | Media file root |
| `FRONTEND_DIR` | `../frontend` | Path to SPA static files |
| `GEMINI_API_KEY` | *(empty)* | Synced to `blog_secrets` at startup; required for AI media analysis |
| `MEDIA_IMPORT_PATH` | *(empty)* | Synced to `blog_secrets` at startup; path for bulk media import |
| `SESSION_EXPIRY_HOURS` | `720` | Auth session TTL |
| `MAX_UPLOAD_SIZE_MB` | `50` | Upload size limit |
| `THUMBNAIL_WIDTH/HEIGHT` | `400/300` | Thumbnail dimensions |

**In production**, `GEMINI_API_KEY` is injected from the system keyring by `build/rebuild.sh` — it is never stored in the repository.

### Secrets architecture

Sensitive values live in a physically separate `blog_secrets` table and never appear in `blog_settings` or any API response. The `GET /api/settings` endpoint exposes only synthetic `_is_set` boolean properties for secrets with UI relevance:

| Secret key | Env var | API-visible property |
|---|---|---|
| `gemini_api_key` | `GEMINI_API_KEY` | `gemini_api_key_is_set` |
| `media_import_path` | `MEDIA_IMPORT_PATH` | `media_import_path_is_set` |
| `_secret_key` | `SECRET_KEY` | *(none — fully invisible)* |

`SettingsService` methods: `GetSecret`, `SetSecret`, `SecretIsSet`, `EnsureSecretKey`. Adding a new secret: add a row to `blog_secrets` via `SetSecret`, add a startup migration if migrating from `blog_settings`, add it to `writableSecretKeys` in `settings.go` only if the admin UI needs to write it.

---

## Go API Patterns

### Layer Structure

```
Handler (internal/api/)
  → Service (internal/services/)
    → Repository (internal/repository/)
      → sqlc models (internal/models/)  ← auto-generated, do not edit
```

### Adding an Endpoint

1. Add query to `sql/queries.sql`, run `sqlc generate` from `api/`
2. Add repository method if needed (hand-written SQL goes in `internal/repository/extended.go`)
3. Implement service logic in `internal/services/`
4. Add handler in `internal/api/`
5. Register route in `cmd/api/main.go`
6. Write tests (`*_test.go` alongside the handler/service)

### Database Migrations

Migrations run at **startup in `main.go`** via `repo.ApplyMigration()`. There are no migration files — `migrations/` is empty and unused. Add new migrations to the slice in `main.go`.

```go
{
    "migration_name",
    `ALTER TABLE posts ADD COLUMN new_column TEXT`,
},
```

### Error Responses

Return JSON with `{"detail": "message"}` to match frontend expectations:

```go
return echo.NewHTTPError(http.StatusNotFound, "post not found")
// or for custom shapes:
return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
```

### Media Visibility

Media has an `is_public` flag. Unauthenticated requests receive 404 for private media (not 403). The `serveSimplifiedMedia` handler in `main.go` enforces this.

---

## Frontend Patterns

### Adding a Page

1. Create `src/pages/light/MyPage.js` or `src/pages/public/MyPage.js`
2. Export a `render(params)` function that returns an HTML string
3. Register route in `src/router.js`

### Adding an API Module

Create `src/api/myresource.js` following the pattern in existing modules — thin wrappers over `client.js` fetch helpers.

### Adding a Component

Create `src/components/{light|public|shared}/MyComponent.js` exporting a class that extends `Component` (`src/components/Component.js`).

### CSS

Edit individual files in `css/common/`, `css/light/`, or `css/public/`. Run `scripts/build-css.sh` to regenerate bundles. **Do not edit bundle files directly.**

---

## AI Integration (Gemini)

- `api/data.yml` defines the prompt template and model priority list
- Models: `gemini-2.5-flash` (default), `gemini-2.5-pro`, preview variants
- Endpoint: `POST /api/media/analyze` — sends image to Gemini, returns `{title, tags, excerpt}`
- Requires `GEMINI_API_KEY` env var or `gemini_api_key` in `blog_secrets`; set via env var, the admin settings UI, or `settingsService.SetSecret`

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `api/cmd/api/main.go` | Entry point, route registration, startup migrations |
| `api/internal/api/mappers.go` | DB model → API response mapping |
| `api/internal/api/middleware.go` | Auth, CORS, security headers |
| `api/sql/schema.sql` | Canonical DB schema |
| `api/sql/queries.sql` | sqlc query source |
| `api/data.yml` | Gemini prompt + model config |
| `frontend/src/router.js` | SPA route definitions |
| `frontend/src/store.js` | Shared app state |
| `frontend/src/api/client.js` | Base fetch wrapper |
| `scripts/run-tests.sh` | Go test runner |
| `scripts/build-css.sh` | CSS bundler |
| `build/rebuild.sh` | Podman build + deploy |
| `MIGRATION_PROGRESS.md` | Remaining Go migration tasks |

---

## Gotchas

- **Container engine is Podman**, not Docker. Use `podman` / `podman-compose`, not `docker` / `docker-compose`.
- **`migrations/` is empty** — DB migrations are registered inline in `main.go`.
- **`internal/models/` is sqlc-generated** — never edit these files; edit `sql/queries.sql` and regenerate.
- **No frontend build step** — the SPA is plain JS served as static files. Changes are live immediately.
- **CSS requires bundling** — editing `.css` files in `css/` requires running `build-css.sh` to take effect.
- **Python backend is fully removed** — there is no `app/` directory, no `venv`, no `pytest`.
- **Auth is session-cookie**, not JWT. Sessions are stored in SQLite.
- **Secrets never appear in `blog_settings`** — `gemini_api_key`, `media_import_path`, and `_secret_key` live in `blog_secrets`. Adding a sensitive setting to `blog_settings` by mistake will expose it in `GET /api/settings`. Use `SetSecret` instead.
- **`GET /api/settings` has no blocklist** — safety is structural: secrets are in a separate table and never fetched by the settings query.

## metaswarm

This project uses [metaswarm](https://github.com/dsifry/metaswarm) for multi-agent orchestration.

**Setup:** Run `/metaswarm-setup` to detect your project and configure metaswarm.

**Update:** Run `/metaswarm-update-version` to update metaswarm.

## MCP
Use 
- serena-go for semantic code retrieval and editing tools for `api` sub-project. **Note:** Paths passed to `serena-go` tools must be relative to the `api/` directory (e.g., use `internal/main.go`, not `api/internal/main.go`).
- serena-js for semantic code retrieval and editing tools for `frontend` sub-project. **Note:** Paths passed to `serena-js` tools must be relative to the `frontend/` directory (e.g., use `src/app.js`, not `frontend/src/app.js`).
- context7 for up to date documentation on third party code
- sqlite for database access


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:b9766037 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
