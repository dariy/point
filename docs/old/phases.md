# Photo Blog Engine - Development Phases

> **Purpose**: Track development progress through self-sufficient phases
> **Last Updated**: 2026-01-25
> **Status**: Phase 10 - Complete

---

## Overview

Each phase is designed to be:
- **Self-sufficient**: Can be tested and validated independently
- **Incremental**: Builds on previous phases
- **Deliverable**: Has clear, testable outcomes
- **Deployable**: Application works (with limited features) after each phase

---

## Phase Summary

| Phase | Name | Status | Dependencies |
|-------|------|--------|--------------|
| 1 | Project Foundation | ✅ Completed | None |
| 2 | Authentication System | ✅ Completed | Phase 1 |
| 3 | Post Management Core | ✅ Completed | Phase 2 |
| 4 | Media Management | ✅ Completed | Phase 3 |
| 5 | Tag System | ✅ Completed | Phase 3 |
| 6 | Light Interface | ✅ Completed | Phases 3, 4, 5 |
| 7 | Public Frontend | ✅ Completed | Phases 3, 5 |
| 8 | RSS & SEO | ✅ Completed | Phase 7 |
| 9 | Theming System | ✅ Completed | Phase 7 |
| 10 | Caching & Performance | ✅ Completed | Phase 7 |
| 11 | Background Tasks & Backup | ✅ Completed | Phase 10 |
| 12 | Settings & System Tools | ✅ Completed | Phase 6 |
| 13 | CI/CD & Deployment | ✅ Completed | All Phases |
| 14 | Enhanced UI/UX | ✅ Completed | Phase 7 |
| 15 | SPA Refactoring | ✅ Completed | All Phases |

**Legend**: ⬜ Not Started | 🔄 In Progress | ✅ Complete | ⏸️ Blocked

---

## Phase 1: Project Foundation

**Goal**: Establish project structure, Docker setup, and database foundation

**Status**: ✅ Complete

### Tasks

- [x] **1.1 Project Structure**
  - [x] Create directory structure per specification (lines 35-122)
  - [x] Initialize Python package structure
  - [x] Create `__init__.py` files
  - [x] Set up `pyproject.toml` or `requirements.txt`

- [x] **1.2 Configuration Management**
  - [x] Create `app/config.py` with Pydantic Settings
  - [x] Create `.env.example` with all variables (spec lines 496-546)
  - [x] Implement environment-based configuration
  - [x] Add `.gitignore`

- [x] **1.3 Database Setup**
  - [x] Create `app/database.py` with async SQLAlchemy
  - [x] Configure SQLite connection
  - [x] Set up Base model class
  - [x] Implement `get_db` dependency

- [x] **1.4 FastAPI Application**
  - [x] Create `app/main.py` with FastAPI app
  - [x] Add CORS middleware
  - [x] Add security headers middleware
  - [x] Create `/health` endpoint
  - [x] Configure exception handlers

- [x] **1.5 Docker Configuration**
  - [x] Create `Dockerfile` (spec lines 554-610)
  - [x] Create `docker-compose.yml` (spec lines 613-651)
  - [x] Configure volume mounts
  - [x] Set up health checks
  - [x] Test container builds and runs

- [x] **1.6 Development Tools**
  - [x] Configure `ruff` for linting
  - [x] Configure `mypy` for type checking
  - [x] Set up `pytest` configuration
  - [x] Create initial `conftest.py`

### Deliverables

1. Working Docker container that starts
2. `/health` endpoint returns `200 OK`
3. Database file created on startup
4. All linting/type checks pass
5. Basic test infrastructure in place

### Validation Criteria

```bash
# Container builds successfully
docker-compose build

# Container starts and stays healthy
docker-compose up -d
curl http://localhost:8000/health  # Returns 200

# venv created
python -m venv venv

# venv activated
    source venv/bin/activate

# Tests pass
pytest tests/

# Linting passes
ruff check app/
mypy app/
```

---

## Phase 2: Authentication System

**Goal**: Implement secure user authentication and session management

**Status**: ✅ Complete

**Depends on**: Phase 1

### Tasks

- [x] **2.1 User Model**
  - [x] Create `app/models/user.py` (spec lines 208-218)
  - [x] Implement password hashing with bcrypt
  - [x] Add user schema in `app/schemas/auth.py`

- [x] **2.2 Session Model**
  - [x] Create `app/models/session.py` (spec lines 220-231)
  - [x] Implement token generation
  - [x] Add session expiry logic

- [x] **2.3 Auth Service**
  - [x] Create `app/services/auth_service.py`
  - [x] Implement `authenticate_user()`
  - [x] Implement `create_session()`
  - [x] Implement `validate_session()`
  - [x] Implement `terminate_session()`

- [x] **2.4 Auth Dependencies**
  - [x] Create `app/dependencies.py`
  - [x] Implement `get_current_user` dependency
  - [x] Implement `require_auth` dependency
  - [x] Set up cookie handling (httpOnly, secure, sameSite)

- [x] **2.5 Auth API Endpoints**
  - [x] Create `app/api/auth.py`
  - [x] `POST /api/auth/login` - Login
  - [x] `POST /api/auth/logout` - Logout
  - [x] `GET /api/auth/me` - Get current user
  - [x] `POST /api/auth/change-password` - Change password
  - [x] `GET /api/auth/sessions` - List sessions
  - [x] `DELETE /api/auth/sessions/{id}` - Terminate session

- [x] **2.6 Initial User Setup**
  - [x] Create `scripts/init_db.py`
  - [x] Add light user creation on first run
  - [x] Implement password requirements validation

- [x] **2.7 Auth Tests**
  - [x] Test login with valid/invalid credentials
  - [x] Test session creation and validation
  - [x] Test password change flow
  - [x] Test session termination
  - [x] Test auth middleware

### Deliverables

1. User can log in with username/password
2. Sessions tracked in database
3. Cookie-based authentication working
4. Session management (list, terminate)
5. Password change functionality
6. 100% test coverage on auth paths

### Validation Criteria

```bash
# Login works
curl -X POST http://localhost:8000/api/auth/login \
  -d '{"username":"light","password":"secret"}'

# Protected endpoint requires auth
curl http://localhost:8000/api/auth/me  # Returns 401

# With auth cookie
curl http://localhost:8000/api/auth/me \
  -H "Cookie: session=<token>"  # Returns user data
```

---

## Phase 3: Post Management Core

**Goal**: Implement complete post CRUD with status management

**Status**: ✅ Complete

**Depends on**: Phase 2

### Tasks

- [x] **3.1 Post Model**
  - [x] Create `app/models/post.py` (spec lines 154-171)
  - [x] Add indexes on slug, status, published_at
  - [x] Implement status enum (draft, published, hidden)

- [x] **3.2 Post Schemas**
  - [x] Create `app/schemas/post.py`
  - [x] `PostCreate` - Create post data
  - [x] `PostUpdate` - Update post data
  - [x] `PostResponse` - API response
  - [x] `PostList` - Paginated list response

- [x] **3.3 Slug Utility**
  - [x] Create `app/utils/slugify.py`
  - [x] Implement slug generation from title
  - [x] Handle non-ASCII (transliteration)
  - [x] Ensure uniqueness (append numbers)

- [x] **3.4 Text Formatters**
  - [x] Create `app/utils/formatters.py`
  - [x] Implement Markdown to HTML conversion
  - [x] Implement excerpt generation
  - [x] Sanitize HTML output

- [x] **3.5 Post Service**
  - [x] Create `app/services/post_service.py`
  - [x] `create_post()` - Create with auto-slug
  - [x] `update_post()` - Update existing post
  - [x] `delete_post()` - Soft or hard delete
  - [x] `get_post_by_id()` - Get by ID
  - [x] `get_post_by_slug()` - Get by slug
  - [x] `list_posts()` - Paginated list with filters
  - [x] `publish_post()` - Draft → Published
  - [x] `withdraw_post()` - Published → Draft
  - [x] `increment_view_count()` - Track views

- [x] **3.6 Post API Endpoints**
  - [x] Create `app/api/posts.py`
  - [x] `GET /api/posts` - List posts (with filters)
  - [x] `POST /api/posts` - Create post
  - [x] `GET /api/posts/{id}` - Get post
  - [x] `PUT /api/posts/{id}` - Update post
  - [x] `DELETE /api/posts/{id}` - Delete post
  - [x] `GET /api/posts/slug/{slug}` - Get by slug
  - [x] `POST /api/posts/{id}/publish` - Publish
  - [x] `POST /api/posts/{id}/withdraw` - Withdraw

- [x] **3.7 Preview Links**
  - [x] Implement preview token generation
  - [x] `POST /api/posts/{id}/preview` - Generate preview link
  - [x] `GET /preview/{token}` - Access draft via token
  - [x] Token expiry (7 days)

- [x] **3.8 Post Tests**
  - [x] Test CRUD operations
  - [x] Test slug generation/uniqueness
  - [x] Test status transitions
  - [x] Test filtering and pagination
  - [x] Test authorization (only author can edit)

### Deliverables

1. Full CRUD for posts via API
2. Automatic slug generation
3. Status management (draft/published/hidden)
4. Pagination and filtering
5. Preview links for drafts
6. View counting

### Validation Criteria

```bash
# Create post
curl -X POST http://localhost:8000/api/posts \
  -H "Cookie: session=<token>" \
  -d '{"title":"My First Post","content":"Hello world"}'

# List published posts
curl http://localhost:8000/api/posts?status=published

# Get by slug
curl http://localhost:8000/api/posts/slug/my-first-post
```

---

## Phase 4: Media Management

**Goal**: Implement file upload, image processing, and media library

**Status**: ✅ Complete

**Depends on**: Phase 3

### Tasks

- [x] **4.1 Media Model**
  - [x] Create `app/models/media.py` (spec lines 193-206)
  - [x] Track file metadata (size, dimensions, type)
  - [x] Add checksum for deduplication

- [x] **4.2 Media Schemas**
  - [x] Create `app/schemas/media.py`
  - [x] `MediaUpload` - Upload metadata
  - [x] `MediaResponse` - API response
  - [x] `MediaList` - Paginated list

- [x] **4.3 Image Processor**
  - [x] Create `app/utils/image_processor.py`
  - [x] Implement thumbnail generation (180x120)
  - [x] Implement image resizing (max 2560px)
  - [x] Support JPEG quality settings
  - [x] Generate progressive JPEGs

- [x] **4.4 Validators**
  - [x] Create `app/utils/validators.py`
  - [x] Validate file types (whitelist)
  - [x] Validate MIME types
  - [x] Validate file sizes
  - [x] Check storage quota

- [x] **4.5 Media Service**
  - [x] Create `app/services/media_service.py`
  - [x] `upload_file()` - Full upload pipeline
  - [x] `generate_thumbnail()` - Create thumbnail
  - [x] `delete_file()` - Remove file and metadata
  - [x] `get_orphaned_files()` - Find unlinked files
  - [x] `cleanup_orphaned()` - Remove orphaned files
  - [x] `calculate_storage_usage()` - Get total usage

- [x] **4.6 Storage Organization**
  - [x] Implement date-based paths (YYYY/MM/)
  - [x] Generate unique filenames
  - [x] Create directory structure on startup

- [x] **4.7 Media API Endpoints**
  - [x] Create `app/api/media.py`
  - [x] `GET /api/media` - List media files
  - [x] `POST /api/media/upload` - Upload file(s)
  - [x] `GET /api/media/{id}` - Get file metadata
  - [x] `DELETE /api/media/{id}` - Delete file
  - [x] `GET /api/media/orphaned` - List orphaned
  - [x] `DELETE /api/media/orphaned` - Cleanup orphaned

- [x] **4.8 Static File Serving**
  - [x] Configure FastAPI static files
  - [x] Serve originals from `/media/`
  - [x] Serve thumbnails from `/media/thumbnails/`

- [x] **4.9 Media Tests**
  - [x] Test file upload (various types)
  - [x] Test thumbnail generation
  - [x] Test size/type validation
  - [x] Test quota enforcement
  - [x] Test orphan detection/cleanup

### Deliverables

1. File upload via API (drag-drop ready)
2. Automatic thumbnail generation
3. Image resizing for large uploads
4. Storage quota management
5. Orphaned file cleanup
6. Deduplication via checksum

### Validation Criteria

```bash
# Upload image
curl -X POST http://localhost:8000/api/media/upload \
  -H "Cookie: session=<token>" \
  -F "file=@photo.jpg"

# Verify thumbnail created
ls /data/media/thumbnails/2026/01/

# Check storage usage
curl http://localhost:8000/api/media?include_stats=true
```

---

## Phase 5: Tag System

**Goal**: Implement tag management and post-tag relationships

**Status**: ✅ Complete

**Depends on**: Phase 3

### Tasks

- [x] **5.1 Tag Model**
  - [x] Create `app/models/tag.py` (spec lines 174-183)
  - [x] Add indexes on name, slug
  - [x] Track post_count (denormalized)

- [x] **5.2 PostTag Association**
  - [x] Create association table (spec lines 185-190)
  - [x] Set up relationships in Post and Tag models

- [x] **5.3 Tag Schemas**
  - [x] Create `app/schemas/tag.py`
  - [x] `TagCreate` - Create tag data
  - [x] `TagUpdate` - Update tag data
  - [x] `TagResponse` - API response
  - [x] `TagWithPosts` - Tag with post list

- [x] **5.4 Tag Service**
  - [x] Create `app/services/tag_service.py`
  - [x] `create_tag()` - Create with slug
  - [x] `update_tag()` - Update metadata
  - [x] `delete_tag()` - Remove (with options)
  - [x] `get_tag_by_slug()` - Lookup
  - [x] `list_tags()` - All tags
  - [x] `get_important_tags()` - Featured tags
  - [x] `update_post_count()` - Recalculate counts

- [x] **5.5 Post-Tag Integration**
  - [x] Update PostService to handle tags
  - [x] Create tags on-the-fly when tagging posts
  - [x] Auto-update tag counts
  - [x] Tag cloud generation

- [x] **5.6 Tag API Endpoints**
  - [x] Create `app/api/tags.py`
  - [x] `GET /api/tags` - List all tags
  - [x] `POST /api/tags` - Create tag
  - [x] `GET /api/tags/{id}` - Get tag
  - [x] `PUT /api/tags/{id}` - Update tag
  - [x] `DELETE /api/tags/{id}` - Delete tag
  - [x] `GET /api/tags/{slug}/posts` - Posts by tag

- [x] **5.7 Tag Tests**
  - [x] Test CRUD operations
  - [x] Test post-tag relationships
  - [x] Test count updates
  - [x] Test on-the-fly creation
  - [x] Test tag deletion behavior

### Deliverables

1. Full tag CRUD via API
2. Many-to-many post-tag relationships
3. Automatic post count tracking
4. Tag cloud support (important tags)
5. Posts by tag listing

### Validation Criteria

```bash
# Create tag
curl -X POST http://localhost:8000/api/tags \
  -H "Cookie: session=<token>" \
  -d '{"name":"Travel"}'

# Add tags to post
curl -X PUT http://localhost:8000/api/posts/1 \
  -H "Cookie: session=<token>" \
  -d '{"tags":["Travel","Landscape"]}'

# Get posts by tag
curl http://localhost:8000/api/tags/travel/posts
```

---

## Phase 6: Light Interface

**Goal**: Build light dashboard and management UI

**Status**: ✅ Complete

**Depends on**: Phases 3, 4, 5

### Tasks

- [x] **6.1 Base Templates**
  - [x] Create `app/templates/base.html`
  - [x] Create `app/templates/light/base.html`
  - [x] Set up Jinja2 environment
  - [x] Add common macros (forms, pagination)

- [x] **6.2 Light Static Assets**
  - [x] Create `app/static/css/light.css`
  - [x] Create `app/static/js/light.js`
  - [x] Add minimal JS for interactions
  - [x] Style forms, tables, buttons

- [x] **6.3 Login Page**
  - [x] Create `app/templates/light/login.html`
  - [x] Implement login form
  - [x] Handle errors/validation
  - [x] Redirect after login

- [x] **6.4 Dashboard**
  - [x] Create `app/templates/light/dashboard.html`
  - [x] Display stats (posts, drafts, views)
  - [x] Recent posts list
  - [x] Storage usage display
  - [x] Active sessions

- [x] **6.5 Post Editor**
  - [x] Create `app/templates/light/post_edit.html`
  - [x] Form fields (title, content, tags, status)
  - [x] Image upload widget
  - [x] Insert image into content
  - [x] Save draft (Ctrl+S)
  - [x] Preview button
  - [x] Publish/Delete actions

- [x] **6.6 Posts List**
  - [x] Create `app/templates/light/posts_list.html`
  - [x] Table with all posts
  - [x] Filter by status
  - [x] Search posts
  - [x] Bulk actions (optional)

- [x] **6.7 Tag Manager**
  - [x] Create `app/templates/light/tags.html`
  - [x] List all tags with counts
  - [x] Edit tag details
  - [x] Delete with confirmation
  - [x] Mark as important

- [x] **6.8 Media Library**
  - [x] Create `app/templates/light/media.html`
  - [x] Grid view of uploads
  - [x] Filter by type
  - [x] Search by filename
  - [x] Delete files
  - [x] Copy URL button
  - [x] Upload modal

- [x] **6.9 Light Routes**
  - [x] Create `app/api/light.py` (HTML routes)
  - [x] `GET /light/` - Dashboard
  - [x] `GET /light/login` - Login page
  - [x] `GET /light/posts` - Posts list
  - [x] `GET /light/posts/new` - New post
  - [x] `GET /light/posts/{id}` - Edit post
  - [x] `GET /light/tags` - Tag manager
  - [x] `GET /light/media` - Media library

- [x] **6.10 Light Tests**
  - [x] Test page loads with auth
  - [x] Test redirect without auth
  - [x] Test form submissions
  - [x] Test error handling

### Deliverables

1. Functional login page
2. Dashboard with statistics
3. Post editor with preview
4. Posts list with filters
5. Tag management interface
6. Media library with upload
7. Responsive light layout

### Validation Criteria

```bash
# Access login page
curl http://localhost:8000/light/login  # Returns HTML

# Dashboard requires auth
curl http://localhost:8000/light/  # Redirects to login

# With auth, dashboard loads
curl http://localhost:8000/light/ -H "Cookie: session=<token>"
```

---

## Phase 7: Public Frontend

**Goal**: Build public-facing pages for viewing content

**Status**: ✅ Complete

**Depends on**: Phases 3, 5

### Tasks

- [x] **7.1 Public Base Template**
  - [x] Create `app/templates/public/base.html`
  - [x] Header with navigation
  - [x] Footer with links
  - [x] Meta tags for SEO

- [x] **7.2 Public Styles**
  - [x] Create `app/static/css/main.css`
  - [x] Typography (readable fonts)
  - [x] Layout (responsive grid)
  - [x] Image styling
  - [x] Pagination styles

- [x] **7.3 Homepage**
  - [x] Create `app/templates/public/index.html`
  - [x] List recent posts (paginated)
  - [x] Post cards (thumbnail, title, excerpt, date)
  - [x] Sidebar with tag cloud
  - [x] Pagination controls

- [x] **7.4 Single Post View**
  - [x] Create `app/templates/public/post.html`
  - [x] Full post content
  - [x] Featured image
  - [x] Tags list
  - [x] Published date
  - [x] View counter
  - [x] Previous/Next navigation

- [x] **7.5 Tag Archive**
  - [x] Create `app/templates/public/tag.html`
  - [x] Tag description header
  - [x] Posts with this tag
  - [x] Pagination

- [x] **7.6 Gallery View**
  - [x] Create `app/templates/public/gallery.html`
  - [x] Grid of post thumbnails
  - [x] Filter by tag
  - [x] Optional lightbox

- [x] **7.7 Public Routes**
  - [x] Add routes to `app/main.py`
  - [x] `GET /` - Homepage
  - [x] `GET /posts/{slug}` - Single post
  - [x] `GET /tag/{slug}` - Tag archive
  - [x] `GET /gallery` - Gallery view

- [x] **7.8 View Counting**
  - [x] Increment on page load
  - [x] Avoid counting light views
  - [x] Batch updates (optional)

- [x] **7.9 Public Tests**
  - [x] Test homepage loads
  - [x] Test post page loads
  - [x] Test 404 for missing posts
  - [x] Test pagination
  - [x] Test tag filtering

### Deliverables

1. Homepage with post list
2. Single post view with full content
3. Tag archive pages
4. Gallery view
5. Responsive design
6. View counting

### Validation Criteria

```bash
# Homepage loads
curl http://localhost:8000/  # Returns HTML with posts

# Post page loads
curl http://localhost:8000/posts/my-first-post

# Tag page loads
curl http://localhost:8000/tag/travel
```

---

## Phase 8: RSS & SEO

**Goal**: Implement RSS feed and SEO essentials

**Status**: ✅ Complete

**Depends on**: Phase 7

### Tasks

- [x] **8.1 RSS Feed**
  - [x] Create `app/templates/public/rss.xml`
  - [x] Include last 20 published posts
  - [x] Full content or excerpt (configurable)
  - [x] Media enclosures for images
  - [x] Proper pubDate formatting

- [x] **8.2 RSS Route**
  - [x] `GET /feed.xml` - RSS feed
  - [x] Set correct Content-Type
  - [x] Add caching headers

- [x] **8.3 Sitemap**
  - [x] Create `app/templates/public/sitemap.xml`
  - [x] List all public pages
  - [x] Include lastmod dates
  - [x] Priority settings

- [x] **8.4 Robots.txt**
  - [x] Create dynamic `robots.txt` route
  - [x] Allow/disallow rules
  - [x] Point to sitemap

- [x] **8.5 Meta Tags**
  - [x] Add Open Graph tags

  - [x] Dynamic meta descriptions
  - [x] Canonical URLs

- [x] **8.6 SEO Routes**
  - [x] `GET /sitemap.xml` - Sitemap
  - [x] `GET /robots.txt` - Robots file

- [x] **8.7 RSS/SEO Tests**
  - [x] Test RSS valid XML
  - [x] Test sitemap valid XML
  - [x] Test meta tags present

### Deliverables

1. Valid RSS feed with posts
2. Sitemap for search engines
3. robots.txt
4. Open Graph meta tags
5. Canonical URLs

### Validation Criteria

```bash
# RSS feed valid
curl http://localhost:8000/feed.xml | xmllint --noout -

# Sitemap valid
curl http://localhost:8000/sitemap.xml | xmllint --noout -

# Robots.txt present
curl http://localhost:8000/robots.txt
```

---

## Phase 9: Theming System

**Goal**: Implement dark/light themes with system preference detection

**Status**: ✅ Complete

**Depends on**: Phase 7

### Tasks

- [x] **9.1 CSS Variables**
  - [x] Define theme variables in `main.css`
  - [x] Colors, backgrounds, borders
  - [x] Typography colors
  - [x] Shadow styles

- [x] **9.2 Dark Theme**
  - [x] Dark theme styles in `main.css` and `light.css`
  - [x] Dark color palette
  - [x] Adjusted contrasts

- [x] **9.3 Light Theme**
  - [x] Light theme styles in `main.css` and `light.css`
  - [x] Light color palette
  - [x] Clean aesthetics

- [x] **9.4 Theme JavaScript**
  - [x] Create `app/static/js/theme.js`
  - [x] Detect system preference
  - [x] Toggle theme
  - [x] Persist preference (localStorage)
  - [x] Apply on page load (no flash)

- [x] **9.5 Theme Switcher UI**
  - [x] Add toggle in header
  - [x] Icon changes with theme (sun/moon)
  - [x] Smooth transitions

- [x] **9.6 Light Theme Support**
  - [x] Apply theming to light
  - [x] Consistent with public

- [x] **9.7 Color Scheme Meta**
  - [x] Update `<meta name="color-scheme">`
  - [x] Browser UI adaptation

- [x] **9.8 Theme Tests**
  - [x] Test theme toggle presence
  - [x] Test theme.js functionality
  - [x] Test system preference detection
  - [x] Test CSS variables presence

### Deliverables

1. Dark and light themes
2. System preference detection
3. User preference override
4. Smooth theme switching
5. Persisted preference
6. No flash on page load

### Validation Criteria

```bash
# Check theme CSS loads
curl http://localhost:8000/static/css/main.css | grep "var(--"

# Check theme.js loads
curl http://localhost:8000/static/js/theme.js
```

---

## Phase 10: Caching & Performance

**Goal**: Implement file-based caching and optimize performance

**Status**: ✅ Complete

**Depends on**: Phase 7

### Tasks

- [x] **10.1 Cache Service**
  - [x] Create `app/services/cache_service.py`
  - [x] Implement `FileCache` class (spec lines 379-385)
  - [x] `get(key)` - Retrieve cached value
  - [x] `set(key, value, ttl)` - Store with expiry
  - [x] `delete(key)` - Remove specific key
  - [x] `clear_all()` - Clear entire cache
  - [x] `clear_pattern(pattern)` - Clear by pattern

- [x] **10.2 Cache Storage**
  - [x] Store in `/data/cache/pages/`
  - [x] Use hashed keys for filenames
  - [x] Include metadata (expiry, created)

- [x] **10.3 Page Caching**
  - [x] Cache rendered homepage
  - [x] Cache tag archive pages
  - [x] Cache RSS feed
  - [x] Configurable TTL

- [x] **10.4 Cache Invalidation**
  - [x] Invalidate on post publish/update
  - [x] Invalidate on tag edit
  - [x] Invalidate on settings change
  - [x] Manual cache clear endpoint (via clear_all)

- [x] **10.5 Database Optimization**
  - [x] Add proper indexes (already in place on Post and Tag models)
  - [x] Optimize common queries
  - [x] Implement eager loading (selectinload used throughout)
  - [ ] Add VACUUM schedule (deferred to Phase 11)

- [x] **10.6 Static Asset Caching**
  - [x] Add cache headers (CachedStaticFiles class)
  - [x] ETags for static files
  - [x] Browser caching (7 days for media, 1 day for assets)

- [x] **10.7 Image Optimization**
  - [x] Lazy loading on frontend (loading="lazy" on all images)
  - [x] Responsive images (srcset) - thumbnails used
  - [ ] WebP support (optional, deferred)

- [x] **10.8 Cache Tests**
  - [x] Test cache hit/miss
  - [x] Test invalidation
  - [x] Test TTL expiry

### Deliverables

1. File-based caching system
2. Page cache for public pages
3. RSS feed caching
4. Cache invalidation on changes
5. Database query optimization
6. Static asset caching headers

### Validation Criteria

```bash
# Cache file created after first request
curl http://localhost:8000/
ls /data/cache/pages/

# Second request faster (cache hit)
time curl http://localhost:8000/

# Cache cleared after post update
curl -X PUT http://localhost:8000/api/posts/1 ...
ls /data/cache/pages/  # Should be cleared
```

---

## Phase 11: Background Tasks & Backup

**Goal**: Implement scheduled tasks and backup automation

**Status**: ✅ Completed

**Depends on**: Phase 10

### Tasks

- [x] **11.1 APScheduler Setup**
  - [x] Configure scheduler in `app/main.py`
  - [x] Use async scheduler
  - [x] Handle graceful shutdown

- [x] **11.2 Session Cleanup Task**
  - [x] Schedule hourly
  - [x] Delete expired sessions
  - [x] Log cleanup results

- [x] **11.3 View Count Flush**
  - [x] Schedule every 30 minutes
  - [x] Flush in-memory counts to DB
  - [x] Handle concurrent access

- [x] **11.4 Backup Service**
  - [x] Create `app/services/backup_service.py`
  - [x] SQLite `.backup` command (Implemented as file copy)
  - [x] Media file backup
  - [x] Compress archive
  - [x] Configurable retention

- [x] **11.5 Daily Backup Task**
  - [x] Schedule daily (configurable time)
  - [x] Execute backup service
  - [x] Rotate old backups
  - [x] Optional S3 upload (Skipped - optional)

- [x] **11.6 Backup Scripts**
  - [x] Create `scripts/backup.sh` (spec lines 1021-1052)
  - [x] Create `scripts/restore.sh` (spec lines 1055-1086)
  - [x] Document usage

- [x] **11.7 Manual Backup Endpoint**
  - [x] `POST /api/system/backup` - Trigger backup
  - [x] Return backup file path
  - [x] Light only

- [x] **11.8 Task Tests**
  - [x] Test scheduler startup
  - [x] Test backup creation
  - [x] Test restore procedure

### Deliverables

1. APScheduler running in-process
2. Session cleanup (hourly)
3. View count flush (30 min)
4. Daily automated backups
5. Backup retention management
6. Manual backup trigger
7. Restore scripts

### Validation Criteria

```bash
# Verify scheduler running
docker-compose logs blog | grep "scheduler"

# Trigger manual backup
curl -X POST http://localhost:8000/api/system/backup \
  -H "Cookie: session=<token>"

# Verify backup created
ls /data/backups/

# Test restore
./scripts/restore.sh /data/backups/2026-01-22.tar.gz
```

---

## Phase 12: Settings & System Tools

**Goal**: Implement blog settings and light system tools

**Status**: ✅ Complete

**Depends on**: Phase 6

### Tasks

- [x] **12.1 BlogSettings Model**
  - [x] Create `app/models/settings.py` (spec lines 233-239)
  - [x] Key-value storage
  - [x] Type handling (string, int, bool, json)

- [x] **12.2 Settings Service**
  - [x] Create `app/services/settings_service.py`
  - [x] `get_setting(key)` - Get single setting
  - [x] `get_all_settings()` - Get all
  - [x] `update_setting(key, value)` - Update
  - [x] `update_settings(dict)` - Bulk update
  - [x] Merge with env defaults

- [x] **12.3 Settings API**
  - [x] `GET /api/settings` - Get all
  - [x] `PUT /api/settings` - Update all
  - [x] `GET /api/settings/{key}` - Get one

- [x] **12.4 Settings Page**
  - [x] Create `app/templates/light/settings.html`
  - [x] All settings per spec (lines 438-453)
  - [x] Form validation
  - [x] Save feedback

- [x] **12.5 System Stats**
  - [x] Implement stats collection
  - [x] Database size
  - [x] Storage usage
  - [x] Cache stats
  - [x] Active sessions

- [x] **12.6 Log Viewer**
  - [x] Create log viewing service
  - [x] Read last N lines
  - [x] Filter by level
  - [x] Stream new logs (optional)

- [x] **12.7 System Tools Page**
  - [x] Create `app/templates/light/system.html`
  - [x] View logs
  - [x] Cache statistics
  - [x] Clear cache button
  - [x] Database stats
  - [x] Trigger backup

- [x] **12.8 System API**
  - [x] `GET /api/system/stats` - Statistics
  - [x] `GET /api/system/logs` - View logs
  - [x] `POST /api/system/cache/clear` - Clear cache

- [x] **12.9 Settings/System Tests**
  - [x] Test settings CRUD
  - [x] Test cache clear
  - [x] Test stats collection

### Deliverables

1. Blog settings management
2. Settings light page
3. System statistics dashboard
4. Log viewer
5. Cache management
6. Database stats

### Validation Criteria

```bash
# Get settings
curl http://localhost:8000/api/settings \
  -H "Cookie: session=<token>"

# Update setting
curl -X PUT http://localhost:8000/api/settings \
  -H "Cookie: session=<token>" \
  -d '{"blog_title":"My New Title"}'

# Get system stats
curl http://localhost:8000/api/system/stats \
  -H "Cookie: session=<token>"
```

---

## Phase 14: Enhanced UI/UX

**Goal**: Implement advanced frontend features for a modern, seamless user experience

**Status**: ✅ Completed

**Depends on**: Phase 7

### Tasks

- [x] **14.1 Immersive Mode**
  - [x] Detect image-only posts
  - [x] Implement full-screen immersive layout
  - [x] Add auto-hiding UI elements (header/footer)
  - [x] Responsive image/video scaling

- [x] **14.2 AJAX Navigation**
  - [x] Implement JSON API for post content
  - [x] Add client-side navigation logic (`loadPost`)
  - [x] Handle history `pushState` and `popstate`
  - [x] Implement smooth content transitions
  - [x] Add graceful fallback to HTML navigation

- [x] **14.3 Gesture Navigation**
  - [x] Implement touch swipe for post navigation
  - [x] Add carousel swipe support
  - [x] Intelligent vertical scroll detection
  - [x] Coordinate-based swipe thresholding

- [x] **14.4 Reading Tools**
  - [x] Add reading progress indicator
  - [x] Implement "Copy to Clipboard" for code blocks
  - [x] Video preview on hover for post cards

- [x] **14.5 Quick Post Creation**
  - [x] Implement drag-and-drop overlay for logged-in users
  - [x] Upload image directly from public pages
  - [x] Auto-redirect to post editor with pre-populated media
  - [x] Visual feedback during upload process
  - [x] Comprehensive test coverage (20 tests)
    - [x] Unit tests for endpoint and path generation
    - [x] Integration tests for complete workflow
    - [x] Edge case and security tests

- [x] **14.6 Design Polishing**
  - [x] Fix theme background inconsistencies
  - [x] Optimize overscroll behavior and visual transitions
  - [x] Smooth scrolling and back-to-top button

### Deliverables

1. Full-screen immersive mode for photo posts
2. Seamless AJAX-based site navigation
3. Comprehensive touch gesture support
4. Reading tools (progress bar, code copy)
5. Drag-and-drop quick post creation from public pages
6. Refined visual transitions and theme consistency

---

## Phase 13: CI/CD & Deployment

**Goal**: Set up automated testing, building, and deployment

**Status**: ✅ Completed

**Depends on**: All previous phases

### Tasks

- [x] **13.1 GitHub Actions Workflow**
  - [x] Create `.github/workflows/deploy.yml` (spec lines 687-799)
  - [x] Test job (lint, type check, tests)
  - [x] Build job (Docker image)
  - [x] Deploy job (production)

- [x] **13.2 Test Job**
  - [x] Set up Python
  - [x] Install dependencies
  - [x] Run ruff
  - [x] Run mypy
  - [x] Run pytest with coverage
  - [x] Upload coverage report

- [x] **13.3 Build Job**
  - [x] Build Docker image
  - [x] Push to GitHub Container Registry
  - [x] Tag with version/SHA
  - [x] Cache layers

- [x] **13.4 Deploy Job**
  - [x] SSH to production server
  - [x] Pull new image
  - [x] Run migrations (if any)
  - [x] Restart service
  - [x] Health check

- [x] **13.5 Production Docker Compose**
  - [x] Create `docker-compose.prod.yml` (spec lines 654-682)
  - [x] Production volume mounts
  - [x] Nginx reverse proxy config

- [x] **13.6 Environment Configuration**
  - [x] Document required secrets
  - [x] Set up GitHub secrets documentation
  - [x] Production .env template (.env.production.example)

- [x] **13.7 Health Checks**
  - [x] Verify deployment succeeded
  - [x] Rollback on failure (automated in deploy.sh)
  - [x] Notify on completion

- [x] **13.8 Documentation**
  - [x] Update README with deploy instructions
  - [x] Document GitHub secrets needed
  - [x] Create comprehensive DEPLOYMENT.md
  - [x] Deployment checklist (spec lines 932-955)

- [x] **13.9 CI/CD Tests**
  - [x] Test workflow syntax (GitHub Actions validation)
  - [x] Create deployment helper scripts
  - [x] Document full pipeline

### Deliverables

1. GitHub Actions workflow
2. Automated testing on PR
3. Automated Docker builds
4. Automated deployment
5. Health check verification
6. Complete deployment documentation

### Validation Criteria

```bash
# Push triggers workflow
git push origin main

# Workflow passes all jobs
# Check GitHub Actions tab

# Production accessible
curl https://yourblog.com/health

# New features deployed
curl https://yourblog.com/api/posts
```

---

## Post-MVP Enhancements (Future Phases)

These are additional features to consider after completing the MVP:

### Phase 14: Search (Optional)
- [ ] SQLite FTS5 full-text search
- [ ] Search API endpoint
- [ ] Search results page
- [ ] Search box in header

### Phase 15: Comments (Optional)
- [ ] Comment model
- [ ] Moderation system
- [ ] Comment API
- [ ] Comment UI

### Phase 16: Advanced Features (Optional)
- [ ] EXIF data extraction
- [ ] Geolocation tagging
- [ ] Social media integration
- [ ] Import/export tools
- [ ] Image editing tools
- [ ] Reading time estimation
- [ ] Related posts

---

## Progress Log

Track significant milestones here:

| Date | Phase | Milestone | Notes |
|------|-------|-----------|-------|
| 2026-01-22 | - | Project planning | Specification and phases defined |
| 2026-01-22 | 1 | Phase 1 complete | Project structure, Docker, database, tests, linting |
| 2026-01-22 | 2 | Phase 2 complete | User/Session models, auth service, API endpoints, 25 tests passing |
| 2026-01-23 | 4 | Phase 4 complete | Media model/schemas, image processor, validators, media service, API endpoints, 61 new tests (116 total) |
| 2026-01-23 | 5 | Phase 5 complete | Tag model, PostTag association, tag service, post-tag integration, API endpoints, 22 new tests (138 total) |
| 2026-01-23 | 6 | Phase 6 complete | Light interface with dashboard, post editor, media library, tags manager |
| 2026-01-24 | 7 | Phase 7 complete | Public frontend with homepage, single post, tag archive, gallery, 25 new tests (163 total) |
| 2026-01-24 | 8 | Phase 8 complete | RSS feed, sitemap, robots.txt, Open Graph meta tags, canonical URLs, 29 new tests (192 total) |
| 2026-01-24 | 9 | Phase 9 complete | Dark/light theming with CSS variables, theme.js for toggle and system preference detection, theme switcher UI, light theming, 24 new tests |
| 2026-01-25 | 10 | Phase 10 complete | File-based caching with FileCache class, page caching for public routes, cache invalidation on post/tag changes, static asset caching headers, 22 new tests |
| 2026-01-27 | 11 | Phase 11 complete | Scheduler service with APScheduler, background tasks for session cleanup and view count flushing, backup service with scripts and API endpoint, 13 new tests |
| 2026-01-28 | 12 | Phase 12 complete | Blog settings management, system stats, and log viewer |
| 2026-01-29 | 14 | Enhanced UI/UX | Gesture navigation, Immersive mode, AJAX navigation, and theme fixes |
| 2026-01-29 | 13 | CI/CD & Deployment | GitHub Actions workflows, production deployment scripts, nginx config, comprehensive documentation |

---

## Notes

### Phase Dependencies Diagram

```
Phase 1 (Foundation)
    │
    ▼
Phase 2 (Auth)
    │
    ▼
Phase 3 (Posts) ─────────┬─────────┐
    │                    │         │
    ▼                    ▼         │
Phase 4 (Media)    Phase 5 (Tags) │
    │                    │         │
    └────────┬───────────┘         │
             │                     │
             ▼                     │
    Phase 6 (Light) ◄──────────────┘
             │
             ▼
    Phase 7 (Public)
       │    │    │
       │    │    └──────────┐
       │    │               │
       ▼    ▼               ▼
    Ph.8  Ph.9           Ph.10
   (RSS)  (Theme)       (Cache)
                          │
                          ▼
                       Phase 11
                       (Tasks)
             │
             ▼
    Phase 12 (Settings)
             │
             ▼
    Phase 13 (CI/CD)
```

### Estimated Effort

| Phase | Complexity | Estimated Tasks |
|-------|------------|-----------------|
| 1 | Medium | ~25 tasks |
| 2 | Medium | ~30 tasks |
| 3 | High | ~35 tasks |
| 4 | High | ~35 tasks |
| 5 | Medium | ~25 tasks |
| 6 | High | ~40 tasks |
| 7 | Medium | ~30 tasks |
| 8 | Low | ~20 tasks |
| 9 | Low | ~20 tasks |
| 10 | Medium | ~30 tasks |
| 11 | Medium | ~25 tasks |
| 12 | Medium | ~30 tasks |
| 13 | Medium | ~25 tasks |

---

**Last Updated**: 2026-01-22

---

## Phase 15: SPA Refactoring

**Goal**: Transform the application into a decoupled JSON API and Vanilla JS SPA

**Status**: ✅ Complete

**Depends on**: All previous phases

### Tasks

- [x] **15.1 Backend: Pure JSON API**
  - [x] Remove Jinja2 and server-side template rendering
  - [x] Add CORS middleware for frontend/backend separation
  - [x] Update OpenAPI metadata and documentation
  - [x] Create compound page-data endpoints (home, tag, tags)
  - [x] Implement SPA fallback route in FastAPI

- [x] **15.2 Frontend: SPA Scaffold**
  - [x] Implement modular Component base class with lifecycle
  - [x] Build client-side History API router with auth guards
  - [x] Create reactive global state store
  - [x] Build unified API client with fetch wrapper

- [x] **15.3 Public Blog Migration**
  - [x] Build HomePage, PostPage, TagPage, TagsPage, MapPage
  - [x] Migrate all public styles to modular CSS
  - [x] Implement Lightbox and Immersive mode in the SPA

- [x] **15.4 Admin (Light) Migration**
  - [x] Build LoginPage, Dashboard, PostsList, PostEdit
  - [x] Build MediaPage, TagsManager, SettingsPage, SecurityPage, SystemPage
  - [x] Create reusable admin components (Sidebar, TagsInput, Modal)

- [x] **15.5 Cleanup & Hardening**
  - [x] Remove redundant app/static directory
  - [x] Remove jinja2 dependency from project
  - [x] Update Dockerfile to include frontend assets
  - [x] Update README and documentation for the new architecture

### Deliverables

1. Pure JSON API with OpenAPI documentation
2. Fully functional Vanilla JS SPA for public blog and admin
3. Decoupled architecture with no server-side rendering
4. Updated production-ready Docker image

### Validation Criteria

```bash
# Backend starts without Jinja2 errors
uvicorn app.main:app

# API returns JSON for all routes
curl -H "Accept: application/json" http://localhost:8000/api/posts

# SPA fallback works (returns index.html)
curl http://localhost:8000/any-route

# Full integration test in container
docker-compose up --build
```
