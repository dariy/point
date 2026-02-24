# API Migration Plan: Python (FastAPI) to Go

This document outlines the strategy for migrating the backend API of the "Point" blog project from Python (FastAPI) to Go.

## 1. Objectives
- **Performance:** Improve response times and concurrency handling.
- **Type Safety:** Leverage Go's strong typing for better maintainability and fewer runtime errors.
- **Deployment:** Produce a single static binary for easier deployment and smaller Docker images.
- **Modernization:** Update the tech stack to industry-standard Go patterns.

## 2. Proposed Go Tech Stack

| Component | Python (Current) | Go (Proposed) |
|-----------|------------------|---------------|
| **Framework** | FastAPI | **Echo** (or Gin) |
| **Database/ORM** | SQLAlchemy (Async) | **sqlc** (Type-safe SQL) + **pgx** (or `database/sql`) |
| **Migrations** | Custom script | **golang-migrate** |
| **Validation** | Pydantic | **go-playground/validator** |
| **Auth/JWT** | python-jose / passlib | **golang-jwt/jwt** / **crypto/bcrypt** |
| **Logging** | Standard logging | **zerolog** or **zap** |
| **Background Tasks** | APScheduler | **gocron** or **asynq** |
| **Image Processing** | Pillow | **disintegration/imaging** |

## 3. Architecture Mapping

The Go project will follow a clean architecture/service-based approach similar to the current structure:

```text
api/
├── cmd/api/            # Entry point
├── internal/
│   ├── api/            # Handlers (Routes)
│   ├── models/         # sqlc generated models
│   ├── services/       # Business logic (mapping 1:1 with Python services)
│   ├── repository/     # Database access (sqlc queries)
│   ├── config/         # Configuration (Viper)
│   └── utils/          # Helpers (Slugify, etc.)
├── migrations/         # SQL migration files
├── sql/                # sqlc schema and queries
├── go.mod
└── sqlc.yaml
```

## 4. Migration Phases

### Phase 1: Foundation (Setup)
1. Initialize Go module.
2. Setup configuration management (Environment variables, `.env`).
3. Setup logging (structured JSON logging).
4. Configure Database connection pool.
5. Setup `sqlc` for code generation from SQL.

### Phase 2: Authentication & User Management
1. Port User models and migrations.
2. Implement Bcrypt password hashing.
3. Implement JWT generation and validation middleware.
4. Implement `/api/auth` endpoints (Login, Refresh, Me).

### Phase 3: Core Blog Features (Posts & Tags)
1. Port Post, Tag, and PostTag models.
2. Implement `PostService` and `TagService`.
3. Implement Handlers for:
   - `GET /api/posts` (with filtering/pagination)
   - `POST /api/posts`
   - `GET /api/tags`
4. Port Markdown rendering logic.

### Phase 4: Media & File Handling
1. Implement local file storage service.
2. Implement image processing (resizing, thumbnails) using `disintegration/imaging`.
3. Implement `/api/media` endpoints.

### Phase 5: System & Settings
1. Implement system information service (uptime, version).
2. Implement dynamic settings service (stored in DB).
3. Port backup/restore logic.

### Phase 6: Background Tasks
1. Setup `gocron` for scheduled tasks (backups, cleanup).
2. Port specific background logic from `scheduler_service.py`.

### Phase 7: Verification & Testing
1. Implement unit tests for services.
2. Implement integration tests for API endpoints.
3. **Side-by-Side Validation:** Run both APIs and compare outputs for identical requests.

### Phase 8: Frontend Transition
1. Update `frontend/src/api/` (if necessary, though the API contract should remain compatible).
2. Update Dockerfiles to build the Go binary.
3. Switch traffic to the Go API.

## 5. Risk Assessment & Mitigations

| Risk | Mitigation |
|------|------------|
| **Database Incompatibility** | Use the same schema; verify migrations carefully. |
| **Feature Parity** | Use the existing Python tests as a specification for Go implementation. |
| **Markdown Rendering** | Use a compatible Go library (e.g., `goldmark`) and verify CSS compatibility. |
| **Auth Interoperability** | Ensure JWT signing keys and algorithms match exactly during transition. |

## 6. Immediate Next Steps
1. Create a `api` directory.
2. Define the database schema in SQL (derived from SQLAlchemy models).
3. Initialize `sqlc` and generate initial boilerplate.
