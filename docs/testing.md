# Testing Conventions

The project follows a strict separation between **Unit Tests** and **Integration Tests** in the Go backend.

## 1. Unit Tests
*   **Location:** Reside in `*_test.go` files next to the source code (e.g., `api/internal/services/auth_service_test.go`).
*   **Mocks:** MUST use the `mockRepository` (defined in `mock_repository_test.go`) to isolate service logic from the database.
*   **Goal:** Test business logic, sanitization, and error handling in total isolation.
*   **Execution:** Run via `go test ./...` or `./scripts/run-tests.sh --unit`.

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
