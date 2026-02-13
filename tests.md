# Test Coverage Improvement Findings - February 12, 2026

## Overview
This session focused on increasing the test coverage of the "point" blog platform towards a 90% target, specifically targeting the API routes.

## Progress Summary
*\*Terminal reports for `public.py` showed inconsistent missing lines despite new tests for AJAX and caching; further validation with HTML reports is recommended.*
*\*\*Reported percentages fluctuated due to shifts in total statement counts or partial test runs.*

## Key Findings & Challenges

### 1. AJAX Branches
A significant portion of missing coverage across all public and light routes was due to untested AJAX branches. The application checks for the `X-Requested-With: XMLHttpRequest` header to return JSON instead of HTML. Adding specific tests with this header resolved many gaps.

### 2. Caching Logic
Verification of cache hits (`X-Cache: HIT`) was missing. Enabling `settings.cache_enabled` and making sequential requests allowed us to cover the "HIT" branches in `public.py` and `system.py`.

### 3. Database Integrity Constraints
Tests for models like `Post` and `Media` initially failed due to missing required fields (`author_id`, `file_type`, `mime_type`). Ensuring these fields are populated in fixtures is critical for integration tests.

### 4. Tag Hierarchy
The `Tag` model uses a many-to-many relationship through `tag_relationships` for hierarchy. Attempting to use `parent_id` as a keyword argument fails; relationships must be managed via the `parents` and `children` collections.

### 5. Error Path Mocking
To achieve high coverage in `system.py` and `auth.py`, it was necessary to mock service-layer exceptions (e.g., `BackupService` failures) using `unittest.mock.patch` to trigger `HTTP 500` and `HTTP 400` error handlers.

## February 13, 2026 - Backup Service Coverage
- Target: `app/services/backup_service.py`
- Initial Coverage: 19%
- Final Coverage: 97%
- New Tests: `tests/system/test_backup_service_coverage.py` (17 tests)
- Highlights: Covered `create_backup`, `restore_backup`, `list_backups`, `delete_backup`, and `cleanup_old_backups` including error paths and edge cases like legacy database names.

