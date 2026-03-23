# Go API Migration: Remaining Implementation Tasks

To achieve full parity with the Python API and enable a seamless frontend switch, the following tasks must be completed in the `api/` implementation.

## 1. Core API Parity
- [x] **Error Response Format:** Implement a custom `echo.HTTPErrorHandler` that returns JSON in the format `{"detail": "error message"}` to match the frontend's expectations.
- [x] **GenAI Integration:** Implement the `POST /api/media/analyze` endpoint in `MediaHandler` to support AI-driven tagging and titling.
- [x] **Tag Coordinates Update:** Implement `POST /api/system/map/update-coords` and the corresponding logic in `TagService` to update missing GPS coordinates for location tags.
- [x] **Security Headers:** Enhance `middleware.Secure` configuration in `main.go` to match the CSP and security headers defined in Python's `SecurityHeadersMiddleware`.

## 2. Background Services & Scheduling
- [x] **Background Scheduler:** Implement a persistent background worker (e.g., using `gocron` or a simple Go-routine loop) to handle:
    - **Session Cleanup:** Hourly task to remove expired sessions from the database.
    - **View Count Flushing:** Periodic task to flush buffered post view counts to the database.
    - **Daily Backups:** Daily task (e.g., 3 AM) to create a compressed archive of the database and media files.
- [x] **View Count Buffering:** Implement a thread-safe buffer for post view counts in `PostService` to avoid database writes on every request, matching Python's performance optimization.

## 3. Media & Content Management
- [x] **Thumbnail Synchronization:** Update `RebuildThumbnails` in `MediaService` to also update the `thumbnail_path` for all posts referencing the processed images.
- [x] **Metadata Extraction:** Ensure `MediaService` extracts and stores all relevant metadata (dimensions, file type, EXIF) during upload, maintaining parity with Python's `ImageProcessor`.
- [x] **File-Based Caching:** Implement a caching layer for feeds (`/feed.xml`, `/sitemap.xml`) and potentially homepage data to improve performance, similar to Python's `CacheService`.

## 4. Infrastructure & Validation
- [ ] **Database Migration Compatibility:** Migrations are currently applied inline at startup in `cmd/api/main.go`. Verify schema compatibility and consider moving to file-based migrations for better auditability.
- [ ] **End-to-End Verification:** Perform a full sweep of all API endpoints using a tool like `bruno` or `curl` to ensure request/response parity for all edge cases.
- [ ] **Frontend Environment Config:** Verify frontend API base URL points to the Go API (port 8000 — same as Python, no change needed).

## 5. Deployment
- [x] **Dockerfile:** Multi-stage build in `build/Dockerfile` — builds Go binary and bundles frontend static assets.
- [x] **Container Compose:** `build/docker-compose.yml` configured for the Go API. Development uses Podman + podman-compose; production uses Docker + docker-compose.
