# Go API Migration: Remaining Implementation Tasks

To achieve full parity with the Python API and enable a seamless frontend switch, the following tasks must be completed in the `go-api/` implementation.

## 1. Core API Parity
- [ ] **Error Response Format:** Implement a custom `echo.HTTPErrorHandler` that returns JSON in the format `{"detail": "error message"}` to match the frontend's expectations.
- [x] **GenAI Integration:** Implement the `POST /api/media/analyze` endpoint in `MediaHandler` to support AI-driven tagging and titling.
- [ ] **Tag Coordinates Update:** Implement `POST /api/system/map/update-coords` and the corresponding logic in `TagService` to update missing GPS coordinates for location tags.
- [ ] **Security Headers:** Enhance `middleware.Secure` configuration in `main.go` to match the CSP and security headers defined in Python's `SecurityHeadersMiddleware`.

## 2. Background Services & Scheduling
- [ ] **Background Scheduler:** Implement a persistent background worker (e.g., using `gocron` or a simple Go-routine loop) to handle:
    - **Session Cleanup:** Hourly task to remove expired sessions from the database.
    - **View Count Flushing:** Periodic task to flush buffered post view counts to the database.
    - **Daily Backups:** Daily task (e.g., 3 AM) to create a compressed archive of the database and media files.
- [ ] **View Count Buffering:** Implement a thread-safe buffer for post view counts in `PostService` to avoid database writes on every request, matching Python's performance optimization.

## 3. Media & Content Management
- [ ] **Thumbnail Synchronization:** Update `RebuildThumbnails` in `MediaService` to also update the `thumbnail_path` for all posts referencing the processed images.
- [ ] **Metadata Extraction:** Ensure `MediaService` extracts and stores all relevant metadata (dimensions, file type, etc.) during upload, maintaining parity with Python's `ImageProcessor`.
- [ ] **File-Based Caching:** Implement a caching layer for feeds (`/feed.xml`, `/sitemap.xml`) and potentially homepage data to improve performance, similar to Python's `CacheService`.

## 4. Infrastructure & Validation
- [ ] **Database Migration Compatibility:** Verify that the Go migration system (`go-api/migrations/`) is fully compatible with the current database schema and can handle future updates without data loss.
- [ ] **End-to-End Verification:** Perform a full sweep of all API endpoints using a tool like `bruno` or `curl` to ensure request/response parity for all edge cases.
- [ ] **Frontend Environment Config:** Update the frontend build/deployment configuration to point to the Go API port (default 8080) instead of the Python API port (default 8000).

## 5. Deployment
- [ ] **Dockerfile Update:** Update the project's `Dockerfile` (or create a new one) to build and serve the Go API and the static frontend assets in a single container.
- [ ] **Docker Compose:** Update `docker-compose.yml` to reflect the switch from Python to Go.
