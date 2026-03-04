# Point Go API

Go implementation of the Point blog API, using Echo v4 and sqlc.

## Project Structure

```
api/
├── cmd/api/main.go         # Entry point; route registration + startup migrations
├── internal/
│   ├── api/                # HTTP handlers (Echo)
│   ├── services/           # Business logic
│   ├── repository/         # DB access (sqlc-generated + extended.go for custom queries)
│   ├── models/             # sqlc-generated models — do not edit directly
│   ├── config/             # Viper config loader
│   └── utils/              # Slug generation, helpers
├── sql/
│   ├── schema.sql          # Source of truth for DB schema
│   └── queries.sql         # sqlc query definitions
├── data.yml                # Gemini AI prompt + model priority list
├── go.mod
└── sqlc.yaml
```

## Development

```bash
# Install sqlc (only needed when changing sql/)
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest

# Regenerate models after editing sql/queries.sql or sql/schema.sql
sqlc generate

# Run dev server (reads .env or uses defaults; serves on :8000)
go run cmd/api/main.go
```

## Testing

```bash
# From the project root:
./scripts/run-tests.sh                           # all packages, with coverage
./scripts/run-tests.sh ./internal/services/...  # specific package
./scripts/run-tests.sh --verbose --race          # verbose + race detector
./scripts/run-tests.sh --html                    # generate coverage.html

# Or directly from api/:
go test ./...
```

## Implementation Status

- [x] Foundation (Config, DB, startup migrations)
- [x] Authentication & User Management (session-cookie, bcrypt)
- [x] Posts & Tags (CRUD, slug, pagination, filtering, hierarchy)
- [x] Media & File Handling (upload, thumbnails, visibility, AI analysis)
- [x] System & Settings (stats, logs, backup, settings)
- [x] Feeds (RSS, sitemap, robots.txt)
- [x] Compound page endpoints (home, tag, tags index)

See [`MIGRATION_PROGRESS.md`](../MIGRATION_PROGRESS.md) for remaining tasks before production switch.
