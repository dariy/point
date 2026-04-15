# Design: Project-Wide Quality and Infrastructure Improvements (April 2026)

## 1. Overview
This design document outlines a series of improvements to the Point Photo Blog project to enhance code quality, maintainability, and reliability. 

## 2. User Personas & Use Cases

### 2.1. Personas
- **Developer**: Focuses on adding new features and refactoring without introducing regressions.
- **Maintainer**: Responsible for long-term health, dependency updates, and merging PRs.
- **DevOps/Admin**: Ensures deployment reliability and system monitoring.

### 2.2. Use Cases
- **Developer**: AS A Developer, I WANT a frontend testing suite SO THAT I can refactor complex UI logic (like gestures) with confidence that I haven't broken existing functionality.
- **Maintainer**: AS A Maintainer, I WANT 80% backend coverage SO THAT I can verify that PRs meet project-wide quality standards before merging.
- **DevOps**: AS A DevOps Admin, I WANT detailed health metrics SO THAT I can proactively identify database or storage issues before they cause service outages.
- **API Consumer**: AS A Developer, I WANT automated API documentation SO THAT I can understand the available endpoints and their expected request/response schemas without reading source code.

## 3. Proposed Improvements

### 3.1. Frontend Testing Infrastructure
- **Framework**: Vitest (Environment: `jsdom` for SPA component testing).
- **Unit Testing**: Focus on `frontend/src/utils/`, `router.js`, and `store.js`.
- **Mocking**: Use **Mock Service Worker (MSW)** to intercept API calls and provide deterministic responses.
- **E2E Testing**: Playwright for critical paths (Login, Upload, Immersive Mode).
    - **State Management**: Use a dedicated `test.db` SQLite instance.
    - **Seeding**: Implement a `scripts/seed-test-data.sh` to reset the database between E2E runs.
    - **Auth**: Use Playwright's `storageState` to reuse authentication state across tests, avoiding redundant logins.

### 3.2. Backend Coverage Hardening
- **Target**: Reaching >80% in `internal/services` and `cmd/api`.
- **TDD Protocol**: All new test cases must follow **RED-GREEN-REFACTOR**:
    1. Write failing test reproducing a gap or edge case (RED).
    2. Implement fix/improvement (GREEN).
    3. Refactor logic while keeping tests passing (REFACTOR).
- **Integration**: Add `api_test.go` to `cmd/api` using `httptest` to exercise the full server lifecycle.

### 3.3. Automated & Secure API Documentation
- **Tooling**: `swaggo/swag` using Go Echo annotations.
- **Security**: 
    - The `/api/docs` endpoint will be **disabled in production** by default.
    - In non-production environments, it will be gated behind `AuthMiddleware`.
- **Integration**: Use `go generate` to trigger documentation updates.

### 3.4. Deployment & Health Verification
- **Verified Uninstall**: Ensure all processes (PID check) and ports (8000) are released.
- **Enhanced Health Check**:
    - **Public `/health`**: Remains a simple `{ "status": "ok" }`.
    - **Admin `/api/system/health`**: Gated by `AuthMiddleware`. Returns detailed telemetry:
      ```json
      {
        "status": "ok",
        "database": { "connected": true, "latency_ms": 5 },
        "storage": { "writable": true, "available_bytes": 1073741824 },
        "version": "1.2.0"
      }
      ```

## 4. Success Criteria
- [ ] **Coverage**: Frontend >50%, Backend >80% (Blocking Gate).
- [ ] **Reliability**: <5% regression rate reported in the first 30 days post-deployment.
- [ ] **Infrastructure**: `scripts/run-all-tests.sh` executes both suites in CI.
- [ ] **Documentation**: OpenAPI spec validates against linting rules (Spectral).

## 5. Risk Assessment
- **Complexity**: Seeding SQLite for E2E requires clean separation of data paths.
- **Performance**: Playwright may increase CI time; mitigate by targeting only critical paths.
