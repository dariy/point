# Reorganize Tests by Feature - Quick Prompt

## One-Line Prompt
```
Review all test files in [DIRECTORY_PATH]. Reorganize them by feature (not by abstract concepts like "coverage" or "gaps"). Fix module-level import issues. Create feature-based test files with clear names. Remove inappropriately named files.
```

## Detailed Prompt Template
```
Let's review test files in [DIRECTORY_PATH].

Issues to address:
1. Inappropriately named test bundles (e.g., "coverage", "gaps", "misc", "utils")
2. Module-level imports not at top of file
3. Tests organized by abstract concepts rather than features

Tasks:
1. Combine inappropriately named test files
2. Fix import ordering (all imports at top: stdlib → third-party → local)
3. Extract tests into feature-based files
4. Use specific, descriptive file names based on what is actually being tested

Remember: "coverage" is not a feature. Organize by actual features like:
- Homepage functionality
- User authentication
- Post detail views
- Tag archives
- RSS feeds
- Caching behavior
- etc.
```

## Example Usage

### For Different Directories

**Admin Tests**:
```
Review all test files in tests/admin/. Reorganize them by feature (not by abstract concepts like "coverage" or "gaps"). Fix module-level import issues. Create feature-based test files with clear names (e.g., test_dashboard.py, test_post_editor.py, test_media_library.py). Remove inappropriately named files.
```

**API Tests**:
```
Review all test files in tests/api/. Reorganize them by feature (not by abstract concepts like "coverage" or "gaps"). Fix module-level import issues. Create feature-based test files with clear names (e.g., test_posts_api.py, test_auth_api.py, test_media_api.py). Remove inappropriately named files.
```

**Service Tests**:
```
Review all test files in tests/services/. Reorganize them by feature (not by abstract concepts like "coverage" or "gaps"). Fix module-level import issues. Create feature-based test files with clear names (e.g., test_cache_service.py, test_backup_service.py, test_post_service.py). Remove inappropriately named files.
```

## Variables to Replace

- `[DIRECTORY_PATH]`: Path to test directory (e.g., `tests/admin/`, `tests/api/`)
- Add feature examples relevant to that directory

## Expected Outcomes

1. **Clear file names**: `test_<specific_feature>.py`
2. **Proper imports**: All at top of file, organized
3. **Feature-based organization**: Each file tests one coherent feature
4. **No generic names**: No "coverage", "gaps", "misc", "utils" files
5. **Working tests**: All tests migrated and passing
