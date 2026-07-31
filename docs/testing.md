# Testing Conventions

The project follows a strict separation between **Unit Tests** and **Integration Tests** in the Go backend.

> **Always pass `-tags=integration`.** A bare `go test ./...` compiles none of
> the integration files and reports a badly misleading picture of the project's
> health. See [The `integration` build tag is load-bearing](#0-the-integration-build-tag-is-load-bearing).

## 0. The `integration` build tag is load-bearing

`//go:build integration` is a compile-time constraint, so `go test ./...`
without the tag does not skip those tests — it never builds them. They are
invisible: nothing is reported as skipped, and the run passes cleanly.

The gap is large. Measured on `internal/services` (2026-07-30):

| Command | Reported coverage |
| --- | --- |
| `go test -cover ./internal/services/` | 35.1% |
| `go test -tags=integration -cover ./internal/services/` | 74.5% |

Roughly half the covered statements in the services layer are reached only
through integration tests. The untagged number is not a real coverage figure
for this package and should never be quoted as one, or used to decide where
tests are needed.

Everything that gates the project already passes the tag — `scripts/check.sh`
(lint, vet and test), `scripts/run-tests.sh` by default, and CI. Only someone
running the bare command by hand gets the misleading number, which is exactly
why it is written down here.

## 1. Unit Tests
*   **Location:** Reside in `*_test.go` files next to the source code (e.g., `api/internal/services/auth_service_test.go`).
*   **Mocks:** MUST use the `mockRepository` (defined in `mock_repository_test.go`) to isolate service logic from the database.
*   **Goal:** Test business logic, sanitization, and error handling in total isolation.
*   **Execution:** Run via `go test ./...` or `./scripts/run-tests.sh --unit`. Note that this runs *only* the unit tests — see section 0 before reading anything into the coverage number it prints.

## 2. Integration Tests
*   **Location:** Reside in `*_integration_test.go` files next to the source code.
*   **Build Tag:** MUST include the `//go:build integration` constraint at the very top of the file.
*   **Database:** Use a real SQLite `:memory:` database (via `setupTestDB`).
*   **Goal:** Verify the interplay between services and the actual repository/SQL layer.
*   **Execution:** Run via `go test -tags=integration ./...` or `./scripts/run-tests.sh` (default).

## 3. Service Pattern
*   **Dependency Injection:** All services MUST accept the `repository.Repository` **interface** in their constructors.
*   **Interface Location:** The main `Repository` interface is defined in `api/internal/repository/db.go` and encompasses both SQLC queries and custom repo methods.

## 4. Test Runner (`scripts/run-tests.sh`)
*   **Default Behavior:** Runs BOTH unit and integration tests (`-tags=integration`).
*   **Unit Only:** Use `--unit` flag.
*   **Verbose:** Use `--verbose` or `-v`.
