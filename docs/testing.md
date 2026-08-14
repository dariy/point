# Testing Conventions

This project strictly separates **Unit Tests** and **Integration Tests** in the Go backend.

> [!NOTE]
> **Integration tests run by default.**
> A bare `go test ./...` will build and run all tests, including integration tests. To run only unit tests, pass the `unit` build tag (`-tags=unit`) or use `./scripts/run-tests.sh --unit`.

## Test Runner (`scripts/run-tests.sh`)

The recommended way to run tests is using the provided script from the project root. It handles paths and tags automatically.

*   **All tests (default):** `./scripts/run-tests.sh` (runs both unit and integration tests)
*   **Unit tests only:** `./scripts/run-tests.sh --unit`
*   **Verbose output:** `./scripts/run-tests.sh --verbose` (or `-v`)
*   **HTML Coverage:** `./scripts/run-tests.sh --html` (generates an HTML coverage report)

## Unit Tests

*   **Location:** Reside in `*_test.go` files next to the source code (e.g., `api/internal/services/auth_service_test.go`).
*   **Mocks:** MUST use the `mockRepository` (defined in `mock_repository_test.go`) to isolate service logic from the database.
*   **Goal:** Test business logic, sanitization, and error handling in total isolation.
*   **Execution:** Use `./scripts/run-tests.sh --unit`. *(Note: Coverage numbers printed during a unit-only run will be artificially low).*

## Integration Tests

*   **Location:** Reside in `*_integration_test.go` files next to the source code.
*   **Build Tag:** MUST include the `//go:build !unit` constraint at the very top of the file.
*   **Database:** Use a real SQLite `:memory:` database (via `setupTestDB`).
*   **Goal:** Verify the interplay between services and the actual repository/SQL layer.
*   **Execution:** Run via `go test ./...` or `./scripts/run-tests.sh` (included by default).

## Service Pattern

*   **Dependency Injection:** All services MUST accept the `repository.Repository` **interface** in their constructors.
*   **Interface Location:** The main `Repository` interface is defined in `api/internal/repository/db.go` and encompasses both SQLC queries and custom repo methods.
