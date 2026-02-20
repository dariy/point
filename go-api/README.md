# Point Go API

This is the Go implementation of the Point blog API.

## Project Structure

- `cmd/api/`: Main entry point.
- `internal/api/`: Handlers and middleware.
- `internal/services/`: Business logic.
- `internal/repository/`: Database access.
- `internal/models/`: Generated models from `sqlc`.
- `sql/`: SQL schema and queries.

## Development

1. Install `sqlc`: `go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest`
2. Generate models: `sqlc generate`
3. Run: `go run cmd/api/main.go`

## Implementation Progress

- [x] Foundation (Config, DB, Logger)
- [x] Authentication & User Management
- [ ] Posts & Tags (In progress)
- [ ] Media & File Handling
- [ ] System & Settings
- [ ] Background Tasks
