# Testing Standards and Organization

## Feature-Based Organization

Tests should be organized by the feature they test, not by technology or generic categories.

### Naming Convention
- File names: `test_<feature_name>.py` (e.g., `test_authentication.py`, `test_post_detail.py`)
- Test functions: `test_<what>_<scenario>_<expected>`

### File Structure
```python
"""Tests for <feature name> functionality."""

# Standard library imports
import pytest
from datetime import datetime
from typing import List

# Third-party imports
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

# Local imports
from app.models.user import User
from app.schemas.post import PostCreate

# Test classes/functions
@pytest.mark.asyncio
async def test_feature_specific_scenario(client: AsyncClient, db: AsyncSession):
    # Arrange
    # Act
    # Assert
    pass
```

## Coverage Best Practices

### AJAX Branches
- Always test AJAX vs non-AJAX responses.
- Use `headers={"X-Requested-With": "XMLHttpRequest"}` to trigger AJAX behavior and expect JSON.

### Caching Logic
- Verify cache hits using `X-Cache: HIT` header in responses.
- Ensure `settings.cache_enabled` is set for these tests.

### Database Integrity
- Ensure required fields for models are populated in fixtures:
  - `Post`: `author_id`
  - `Media`: `file_type`, `mime_type`

### Tag Hierarchy
- Use `parents` and `children` collections to manage hierarchy in `Tag` model, not `parent_id`.

### Error Handling
- Mock service-layer exceptions using `unittest.mock.patch` to verify `HTTP 500` and `HTTP 400` paths.

## Import Ordering
1. Standard library
2. Third-party libraries
3. Local application modules
