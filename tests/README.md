# Test Directory Structure

This document describes the organization of the test suite.

## Directory Organization

The tests are organized by **feature/module** rather than by layer (API/service). This makes it easier to find all tests related to a specific feature.

```
tests/
├── admin/              # Admin interface tests
│   └── test_api.py
├── auth/               # Authentication & authorization
│   ├── test_api.py
│   ├── test_login.py
│   └── test_service.py
├── posts/              # Post management
│   ├── test_api.py
│   ├── test_service.py
│   ├── test_quick_post.py
│   ├── test_thumbnail.py
│   └── test_view_counts.py
├── media/              # Media/file management
│   ├── test_api.py
│   └── test_service.py
├── tags/               # Tag management
│   ├── test_api.py
│   ├── test_service.py
│   └── test_tag_cloud.py
├── public/             # Public-facing features
│   ├── test_api.py
│   ├── test_ajax.py
│   └── test_security_ui.py
├── settings/           # Settings management
│   ├── test_api.py
│   └── test_service.py
├── system/             # System features & utilities
│   ├── test_api.py
│   ├── test_service.py
│   ├── test_backup.py
│   ├── test_cache.py
│   ├── test_scheduler.py
│   └── test_health.py
├── utils/              # Utility functions
│   ├── test_formatters.py
│   ├── test_image_processor.py
│   ├── test_slugify.py
│   └── test_validators.py
├── infrastructure/     # Infrastructure & main app
│   └── test_main.py
├── conftest.py         # Pytest fixtures
└── __init__.py
```

## Naming Conventions

### Files
- `test_api.py` - Main API endpoint tests for the module
- `test_service.py` - Service layer / business logic tests
- `test_<feature>.py` - Feature-specific tests (e.g., `test_quick_post.py`, `test_ajax.py`)

### Tests
- Follow pattern: `test_<function>_<scenario>_<expected>`
- Example: `test_create_post_with_valid_data_returns_201`

## Coverage

All `*_coverage.py` files have been merged into their main counterparts. The focus is on **functional documentation** of features rather than separate coverage tracking.

## Running Tests

```bash
# Run all tests
pytest tests/

# Run tests for a specific module
pytest tests/posts/

# Run a specific test file
pytest tests/posts/test_api.py

# Run with coverage
pytest tests/ --cov=app --cov-report=html
```

## Finding Tests

To find all tests related to a feature:
1. Navigate to the feature directory (e.g., `tests/posts/`)
2. All tests for that feature are in that directory

Example: All post-related tests are in `tests/posts/`:
- `test_api.py` - API endpoint tests
- `test_service.py` - Business logic tests
- `test_quick_post.py` - Quick post creation feature
- `test_thumbnail.py` - Thumbnail generation
- `test_view_counts.py` - View count tracking

## Migration Notes

**Date**: 2026-01-31

The test directory was reorganized from a layer-based structure (test_api/, test_services/, test_utils/) to a feature-based structure. This provides:

1. **Better organization** - All tests for a feature are together
2. **Easier navigation** - Want to test media? Go to `media/` folder
3. **Clearer purpose** - Each file has a specific focus
4. **Reduced duplication** - Coverage files merged into main tests

### Old Structure
```
tests/
├── test_api/           # All API tests
├── test_services/      # All service tests
├── test_utils/         # All utility tests
└── test_models/        # All model tests
```

### New Structure
```
tests/
├── admin/              # All admin-related tests
├── posts/              # All post-related tests
├── media/              # All media-related tests
└── ...                 # etc.
```
