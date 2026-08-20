# Point Go API

Go implementation of the Point blog API, using Echo v4 and sqlc.

## Project Structure

```
api/
├── cmd/api/                # Entry point; one concern per file (main, cli,
│                           #   wiring, server, routes, cache, assets, media)
├── internal/
│   ├── api/                # HTTP handlers (Echo)
│   ├── services/           # Business logic
│   ├── repository/         # DB access: the Repository interface (db.go, which
│   │                       #   embeds the sqlc Querier) + hand-written queries
│   ├── models/             # sqlc-generated models — do not edit directly
│   ├── migrations/         # Startup schema/data migrations
│   ├── plugins/            # Plugin registry (the enabled-only catalog)
│   ├── mcp/                # In-process MCP server at /mcp
│   ├── config/             # Viper config loader
│   └── utils/              # Slug generation, helpers
├── sql/
│   ├── schema.sql          # Source of truth for DB schema
│   └── queries.sql         # sqlc query definitions
├── data.yml                # Gemini AI prompt + model priority list
├── go.mod
└── sqlc.yaml
```

Which file to edit for a given change:
[docs/architecture/map.md](../docs/architecture/map.md).

## Development

```bash
# Install sqlc (only needed when changing sql/)
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest

# Regenerate models after editing sql/queries.sql or sql/schema.sql
sqlc generate

# Run dev server (reads .env or uses defaults; serves on :8000)
go run ./cmd/api
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
