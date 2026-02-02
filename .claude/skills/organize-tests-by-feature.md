# Organize Tests By Feature

## Description
Reorganizes test files in a directory by extracting tests into feature-based files, fixing import issues, and removing inappropriately named test bundles.

## Usage
```
Use this skill to reorganize tests in [directory_path]
```

## What This Skill Does

1. **Reviews all test files** in the specified directory
2. **Identifies organizational issues**:
   - Inappropriately named files (e.g., "coverage", "gaps", generic names)
   - Module-level imports not at top of file
   - Tests organized by abstract concepts rather than features
3. **Reorganizes by feature**:
   - Groups tests by what they actually test (e.g., homepage, authentication, API endpoints)
   - Creates clear, descriptive file names
   - Consolidates duplicate/overlapping tests
4. **Fixes code quality issues**:
   - Moves all imports to top of file
   - Organizes imports: stdlib → third-party → local
   - Ensures proper test structure

## Process

### Step 1: Analysis
- Read all `test*.py` files in the target directory
- Identify what features are actually being tested
- Note organizational problems:
  - Abstract/generic file names
  - Import ordering issues
  - Mixed concerns in single files

### Step 2: Feature Identification
Group tests by actual features being tested, such as:
- **Homepage/Landing pages** - pagination, listing, filters
- **Detail views** - single item display, AJAX responses
- **Archives/Collections** - tag pages, category pages, galleries
- **Feeds** - RSS, Atom, JSON feeds
- **Sitemaps** - XML sitemaps, robots.txt
- **Caching** - cache behavior, headers, invalidation
- **Settings/Configuration** - context, overrides, defaults
- **Navigation** - prev/next links, breadcrumbs
- **Authentication** - login, logout, sessions
- **Authorization** - permissions, access control
- **Search** - search functionality, filters
- **Forms** - validation, submission, errors

### Step 3: File Creation
For each feature, create a test file with:

**Naming Convention**: `test_<feature_name>.py`
- Use specific, descriptive names
- Avoid generic terms like "coverage", "gaps", "misc", "utils"
- Use underscores for multi-word features: `test_user_profile.py`

**File Structure**:
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

# Test fixtures (if needed for this specific feature)
@pytest.fixture
async def sample_data(db: AsyncSession):
    """Create sample data for testing."""
    # Setup code
    yield data
    # Teardown code

# Test classes/functions
@pytest.mark.asyncio
async def test_feature_specific_scenario(client: AsyncClient, db: AsyncSession):
    """Test description following pattern: test_<what>_<scenario>_<expected>."""
    # Arrange
    # Act
    # Assert
    pass
```

### Step 4: Test Migration
For each test in old files:
1. Determine which feature it tests
2. Copy to appropriate new file
3. Ensure imports are correct
4. Update any fixtures or dependencies
5. Verify test naming follows convention

### Step 5: Cleanup
1. Delete old inappropriately named files
2. Verify all tests are accounted for
3. Run test suite to ensure nothing broke
4. Update any documentation references

## Quality Checklist

Before completing the reorganization:

- [ ] All imports are at top of file
- [ ] Imports organized: stdlib → third-party → local
- [ ] File names are specific and descriptive
- [ ] No generic names ("coverage", "misc", "utils", "test")
- [ ] Each file tests a single coherent feature
- [ ] Test names follow pattern: `test_<what>_<scenario>_<expected>`
- [ ] Fixtures are in appropriate conftest.py or test file
- [ ] No duplicate tests across files
- [ ] All tests from old files are migrated
- [ ] Old files are deleted
- [ ] Tests still pass after reorganization

## Example Transformations

### Before (Bad)
```
tests/
├── test_coverage_gaps.py        # Generic name, mixed concerns
├── test_public_coverage.py      # Generic name, unclear purpose
└── test_ajax.py                 # Imports not at top, mixed features
```

### After (Good)
```
tests/
├── test_homepage.py             # Specific: homepage functionality
├── test_post_detail.py          # Specific: single post views
├── test_tag_archive.py          # Specific: tag archive pages
├── test_rss_feed.py             # Specific: RSS feed generation
├── test_sitemap.py              # Specific: sitemap generation
├── test_caching.py              # Specific: caching behavior
├── test_settings.py             # Specific: settings/config
└── test_navigation.py           # Specific: prev/next navigation
```

## Common Anti-Patterns to Fix

1. **Abstract Naming**
   - ❌ `test_coverage_gaps.py`
   - ✅ `test_homepage.py`, `test_authentication.py`

2. **Technology-Focused Names**
   - ❌ `test_ajax.py`, `test_api.py`
   - ✅ `test_user_profile.py`, `test_search.py`

3. **Generic Groupings**
   - ❌ `test_misc.py`, `test_utils.py`, `test_helpers.py`
   - ✅ `test_email_notifications.py`, `test_image_processing.py`

4. **Mixed Concerns**
   - ❌ One file testing homepage, login, and settings
   - ✅ Separate files for each feature

5. **Import Issues**
   - ❌ Imports scattered throughout file
   - ✅ All imports at top, properly organized

## Notes

- This skill focuses on organization, not test content
- Tests should remain functionally identical after reorganization
- If tests are poorly written, that's a separate refactoring task
- Always run the test suite after reorganization to verify nothing broke
- Consider test coverage reports to ensure no tests were lost

## Examples of Feature Categories

**Public-Facing Features**:
- Homepage/Landing page
- Post/Article detail view
- Category/Tag archives
- Search results
- User profiles (public view)
- Comments section
- Contact forms

**light/Authenticated Features**:
- Dashboard
- Post editor
- Media library
- User management
- Settings/Configuration
- Analytics/Reports

**System Features**:
- Authentication (login/logout)
- Authorization (permissions)
- Session management
- Caching
- Background tasks
- Email sending
- File uploads

**API Endpoints**:
- RESTful resource endpoints
- GraphQL resolvers
- WebSocket handlers

**Integration Points**:
- External API integrations
- Payment processing
- Social media sharing
- Email service providers

## Implementation Steps

When using this skill:

1. **Invoke with target directory**:
   ```
   Reorganize tests by feature in tests/light/
   ```

2. **Review current structure**:
   - List all test files
   - Identify patterns and anti-patterns
   - Map out feature categories

3. **Create new structure**:
   - Design feature-based file organization
   - Create new test files
   - Migrate tests

4. **Verify**:
   - Run test suite
   - Check coverage
   - Review diffs

5. **Document**:
   - Update test documentation
   - Note any test improvements needed
