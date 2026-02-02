# Test Coverage Analysis

**Current Coverage**: 80.81% (Goal: 90%)
**Tests**: 572 passing

## Recent Improvements

- **app/utils/formatters.py**: 60% → 99% (+48 tests)
- **Overall**: 78.41% → 80.81%

## Files Needing Improvement

### Priority 1: app/api/public.py (50% → 90%)
**Missing**: 129 lines
**Key gaps**:
- Lines 97-101: get_db_context() blog_settings parameter handling
- Lines 104-118: get_db_context() context building
- Lines 203-243: homepage() pagination and AJAX handling edge cases
- Lines 254-274: homepage() caching logic
- Lines 317-333: single_post() error handling and caching
- Lines 355-381: single_post() thumbnail and prev/next logic
- Lines 389-443: single_post() AJAX response and template rendering
- Lines 493-541: tag_archive() edge cases
- Lines 545-569: tag_archive() caching
- Lines 606-630, 640-709: tags_page() routes
- Lines 762-803: RSS feed edge cases
- Lines 858-893: sitemap and robots.txt edge cases

**Tests to add**:
1. Homepage with custom blog_settings override
2. Homepage AJAX with pagination edge cases
3. Single post with user logged in (cache skip)
4. Single post with thumbnail not in content
5. Single post AJAX with blog_settings
6. Tag archive with empty results
7. Tags page filtering
8. RSS feed with various post configurations
9. Sitemap with hidden posts

### Priority 2: app/api/system.py (54% → 90%)
**Missing**: 32 lines (88-90, 103-108, 128-145, 163-176)

**Tests to add**:
1. Error handling in backup operations
2. Stats calculation edge cases
3. Log viewing with filters

### Priority 3: app/api/posts.py (64% → 90%)
**Missing**: 31 lines (112-114, 146, 169-184, 204-214, 245, 290-291, 298, 321-322, 329, 356-357, 363-375, 400-406)

**Tests to add**:
1. Post creation with validation errors
2. Post update with status transitions
3. Post deletion with foreign key constraints
4. Bulk operations error handling

### Priority 4: app/api/auth.py (67% → 90%)
**Missing**: 18 lines (61-62, 71-72, 86-101, 173-179, 196-204, 230, 250)

**Tests to add**:
1. Login with invalid credentials variations
2. Token refresh edge cases
3. Session cleanup scenarios
4. Password change validation

### Priority 5: app/api/light.py (71% → 90%)
**Missing**: 44 lines (72-77, 140, 142-145, 153-168, 210-223, 256-276, 305-327, 363-378, 414, 418-431, 451, 458-464, 507)

**Tests to add**:
1. Dashboard stats calculation
2. Media library operations
3. Post preview modes
4. Settings validation

### Priority 6: app/services/tag_service.py (74% → 90%)
**Missing**: 35 lines (170, 177-179, 187-196, 202, 205-206, 222-225, 229, 232-233, 277, 330-337, 342-344, 408-418, 425-427, 443-447, 478-479)

**Tests to add**:
1. Tag merge operations
2. Tag deletion with post associations
3. Tag cloud generation edge cases
4. Tag statistics calculations

## Strategy

To reach 90% overall coverage:
1. Focus on public.py first (biggest impact: 129 lines)
2. Add targeted tests for specific uncovered lines
3. Focus on error paths and edge cases
4. Test caching logic variations
5. Test authentication/authorization boundaries

## Coverage by Module

| Module | Current | Target | Status |
|--------|---------|--------|--------|
| formatters.py | 99% | 90% | ✅ Complete |
| schemas/* | 100% | 90% | ✅ Complete |
| config.py | 100% | 90% | ✅ Complete |
| settings.py | 100% | 90% | ✅ Complete |
| system_service.py | 96% | 90% | ✅ Complete |
| slugify.py | 95% | 90% | ✅ Complete |
| logging.py | 94% | 90% | ✅ Complete |
| post.py (model) | 91% | 90% | ✅ Complete |
| dependencies.py | 90% | 90% | ✅ Complete |
| auth_service.py | 90% | 90% | ✅ Complete |
| image_processor.py | 87% | 90% | ⚠️ Minor gap |
| backup_service.py | 85% | 90% | ⚠️ Minor gap |
| post_service.py | 84% | 90% | ⚠️ Minor gap |
| cache_service.py | 84% | 90% | ⚠️ Minor gap |
| scheduler.py | 83% | 90% | ⚠️ Minor gap |
| settings_service.py | 83% | 90% | ⚠️ Minor gap |
| media_service.py | 82% | 90% | ⚠️ Minor gap |
| media.py (model) | 82% | 90% | ⚠️ Minor gap |
| validators.py | 80% | 90% | ⚠️ Minor gap |
| database.py | 79% | 90% | ⚠️ Minor gap |
| media.py (API) | 77% | 90% | ❌ Needs work |
| tags.py (API) | 76% | 90% | ❌ Needs work |
| tag_service.py | 74% | 90% | ❌ Needs work |
| main.py | 73% | 90% | ❌ Needs work |
| light.py | 71% | 90% | ❌ Needs work |
| auth.py | 67% | 90% | ❌ Needs work |
| posts.py | 64% | 90% | ❌ Needs work |
| system.py | 54% | 90% | ❌ Needs work |
| public.py | 50% | 90% | ❌ Needs work |
