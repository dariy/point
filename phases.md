# Photo Blog Engine - Development Phases

> **Purpose**: Track development progress through self-sufficient phases
> **Last Updated**: 2026-01-22
> **Status**: Phase 1 - Not Started

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
| 1 | Project Foundation | ⬜ Not Started | None |
| 2 | Authentication System | ⬜ Not Started | Phase 1 |
| 3 | Post Management Core | ⬜ Not Started | Phase 2 |
| 4 | Media Management | ⬜ Not Started | Phase 3 |
| 5 | Tag System | ⬜ Not Started | Phase 3 |
| 6 | Admin Interface | ⬜ Not Started | Phases 3, 4, 5 |
| 7 | Public Frontend | ⬜ Not Started | Phases 3, 5 |
| 8 | RSS & SEO | ⬜ Not Started | Phase 7 |
| 9 | Theming System | ⬜ Not Started | Phase 7 |
| 10 | Caching & Performance | ⬜ Not Started | Phase 7 |
| 11 | Background Tasks & Backup | ⬜ Not Started | Phase 10 |
| 12 | Settings & System Tools | ⬜ Not Started | Phase 6 |
| 13 | CI/CD & Deployment | ⬜ Not Started | All Phases |

**Legend**: ⬜ Not Started | 🔄 In Progress | ✅ Complete | ⏸️ Blocked

---

## Phase 1: Project Foundation

**Goal**: Establish project structure, Docker setup, and database foundation

**Status**: ⬜ Not Started

### Tasks

- [ ] **1.1 Project Structure**
  - [ ] Create directory structure per specification (lines 35-122)
  - [ ] Initialize Python package structure
  - [ ] Create `__init__.py` files
  - [ ] Set up `pyproject.toml` or `requirements.txt`

- [ ] **1.2 Configuration Management**
  - [ ] Create `app/config.py` with Pydantic Settings
  - [ ] Create `.env.example` with all variables (spec lines 496-546)
  - [ ] Implement environment-based configuration
  - [ ] Add `.gitignore`

- [ ] **1.3 Database Setup**
  - [ ] Create `app/database.py` with async SQLAlchemy
  - [ ] Configure SQLite connection
  - [ ] Set up Base model class
  - [ ] Implement `get_db` dependency

- [ ] **1.4 FastAPI Application**
  - [ ] Create `app/main.py` with FastAPI app
  - [ ] Add CORS middleware
  - [ ] Add security headers middleware
  - [ ] Create `/health` endpoint
  - [ ] Configure exception handlers

- [ ] **1.5 Docker Configuration**
  - [ ] Create `Dockerfile` (spec lines 554-610)
  - [ ] Create `docker-compose.yml` (spec lines 613-651)
  - [ ] Configure volume mounts
  - [ ] Set up health checks
  - [ ] Test container builds and runs

- [ ] **1.6 Development Tools**
  - [ ] Configure `ruff` for linting
  - [ ] Configure `mypy` for type checking
  - [ ] Set up `pytest` configuration
  - [ ] Create initial `conftest.py`

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

# Tests pass
pytest tests/

# Linting passes
ruff check app/
mypy app/
```

---

## Phase 2: Authentication System

**Goal**: Implement secure user authentication and session management

**Status**: ⬜ Not Started

**Depends on**: Phase 1

### Tasks

- [ ] **2.1 User Model**
  - [ ] Create `app/models/user.py` (spec lines 208-218)
  - [ ] Implement password hashing with bcrypt
  - [ ] Add user schema in `app/schemas/auth.py`

- [ ] **2.2 Session Model**
  - [ ] Create `app/models/session.py` (spec lines 220-231)
  - [ ] Implement token generation
  - [ ] Add session expiry logic

- [ ] **2.3 Auth Service**
  - [ ] Create `app/services/auth_service.py`
  - [ ] Implement `authenticate_user()`
  - [ ] Implement `create_session()`
  - [ ] Implement `validate_session()`
  - [ ] Implement `terminate_session()`

- [ ] **2.4 Auth Dependencies**
  - [ ] Create `app/dependencies.py`
  - [ ] Implement `get_current_user` dependency
  - [ ] Implement `require_auth` dependency
  - [ ] Set up cookie handling (httpOnly, secure, sameSite)

- [ ] **2.5 Auth API Endpoints**
  - [ ] Create `app/api/auth.py`
  - [ ] `POST /api/auth/login` - Login
  - [ ] `POST /api/auth/logout` - Logout
  - [ ] `GET /api/auth/me` - Get current user
  - [ ] `POST /api/auth/change-password` - Change password
  - [ ] `GET /api/auth/sessions` - List sessions
  - [ ] `DELETE /api/auth/sessions/{id}` - Terminate session

- [ ] **2.6 Initial User Setup**
  - [ ] Create `scripts/init_db.py`
  - [ ] Add admin user creation on first run
  - [ ] Implement password requirements validation

- [ ] **2.7 Auth Tests**
  - [ ] Test login with valid/invalid credentials
  - [ ] Test session creation and validation
  - [ ] Test password change flow
  - [ ] Test session termination
  - [ ] Test auth middleware

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
  -d '{"username":"admin","password":"secret"}'

# Protected endpoint requires auth
curl http://localhost:8000/api/auth/me  # Returns 401

# With auth cookie
curl http://localhost:8000/api/auth/me \
  -H "Cookie: session=<token>"  # Returns user data
```

---

## Phase 3: Post Management Core

**Goal**: Implement complete post CRUD with status management

**Status**: ⬜ Not Started

**Depends on**: Phase 2

### Tasks

- [ ] **3.1 Post Model**
  - [ ] Create `app/models/post.py` (spec lines 154-171)
  - [ ] Add indexes on slug, status, published_at
  - [ ] Implement status enum (draft, published, hidden)

- [ ] **3.2 Post Schemas**
  - [ ] Create `app/schemas/post.py`
  - [ ] `PostCreate` - Create post data
  - [ ] `PostUpdate` - Update post data
  - [ ] `PostResponse` - API response
  - [ ] `PostList` - Paginated list response

- [ ] **3.3 Slug Utility**
  - [ ] Create `app/utils/slugify.py`
  - [ ] Implement slug generation from title
  - [ ] Handle non-ASCII (transliteration)
  - [ ] Ensure uniqueness (append numbers)

- [ ] **3.4 Text Formatters**
  - [ ] Create `app/utils/formatters.py`
  - [ ] Implement Markdown to HTML conversion
  - [ ] Implement excerpt generation
  - [ ] Sanitize HTML output

- [ ] **3.5 Post Service**
  - [ ] Create `app/services/post_service.py`
  - [ ] `create_post()` - Create with auto-slug
  - [ ] `update_post()` - Update existing post
  - [ ] `delete_post()` - Soft or hard delete
  - [ ] `get_post_by_id()` - Get by ID
  - [ ] `get_post_by_slug()` - Get by slug
  - [ ] `list_posts()` - Paginated list with filters
  - [ ] `publish_post()` - Draft → Published
  - [ ] `withdraw_post()` - Published → Draft
  - [ ] `increment_view_count()` - Track views

- [ ] **3.6 Post API Endpoints**
  - [ ] Create `app/api/posts.py`
  - [ ] `GET /api/posts` - List posts (with filters)
  - [ ] `POST /api/posts` - Create post
  - [ ] `GET /api/posts/{id}` - Get post
  - [ ] `PUT /api/posts/{id}` - Update post
  - [ ] `DELETE /api/posts/{id}` - Delete post
  - [ ] `GET /api/posts/slug/{slug}` - Get by slug
  - [ ] `POST /api/posts/{id}/publish` - Publish
  - [ ] `POST /api/posts/{id}/withdraw` - Withdraw

- [ ] **3.7 Preview Links**
  - [ ] Implement preview token generation
  - [ ] `GET /api/posts/{id}/preview` - Generate preview link
  - [ ] `GET /preview/{token}` - Access draft via token
  - [ ] Token expiry (7 days)

- [ ] **3.8 Post Tests**
  - [ ] Test CRUD operations
  - [ ] Test slug generation/uniqueness
  - [ ] Test status transitions
  - [ ] Test filtering and pagination
  - [ ] Test authorization (only author can edit)

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

**Status**: ⬜ Not Started

**Depends on**: Phase 3

### Tasks

- [ ] **4.1 Media Model**
  - [ ] Create `app/models/media.py` (spec lines 193-206)
  - [ ] Track file metadata (size, dimensions, type)
  - [ ] Add checksum for deduplication

- [ ] **4.2 Media Schemas**
  - [ ] Create `app/schemas/media.py`
  - [ ] `MediaUpload` - Upload metadata
  - [ ] `MediaResponse` - API response
  - [ ] `MediaList` - Paginated list

- [ ] **4.3 Image Processor**
  - [ ] Create `app/utils/image_processor.py`
  - [ ] Implement thumbnail generation (180x120)
  - [ ] Implement image resizing (max 2560px)
  - [ ] Support JPEG quality settings
  - [ ] Generate progressive JPEGs

- [ ] **4.4 Validators**
  - [ ] Create `app/utils/validators.py`
  - [ ] Validate file types (whitelist)
  - [ ] Validate MIME types
  - [ ] Validate file sizes
  - [ ] Check storage quota

- [ ] **4.5 Media Service**
  - [ ] Create `app/services/media_service.py`
  - [ ] `upload_file()` - Full upload pipeline
  - [ ] `generate_thumbnail()` - Create thumbnail
  - [ ] `delete_file()` - Remove file and metadata
  - [ ] `get_orphaned_files()` - Find unlinked files
  - [ ] `cleanup_orphaned()` - Remove orphaned files
  - [ ] `calculate_storage_usage()` - Get total usage

- [ ] **4.6 Storage Organization**
  - [ ] Implement date-based paths (YYYY/MM/)
  - [ ] Generate unique filenames
  - [ ] Create directory structure on startup

- [ ] **4.7 Media API Endpoints**
  - [ ] Create `app/api/media.py`
  - [ ] `GET /api/media` - List media files
  - [ ] `POST /api/media/upload` - Upload file(s)
  - [ ] `GET /api/media/{id}` - Get file metadata
  - [ ] `DELETE /api/media/{id}` - Delete file
  - [ ] `GET /api/media/orphaned` - List orphaned
  - [ ] `DELETE /api/media/orphaned` - Cleanup orphaned

- [ ] **4.8 Static File Serving**
  - [ ] Configure FastAPI static files
  - [ ] Serve originals from `/media/`
  - [ ] Serve thumbnails from `/thumbnails/`

- [ ] **4.9 Media Tests**
  - [ ] Test file upload (various types)
  - [ ] Test thumbnail generation
  - [ ] Test size/type validation
  - [ ] Test quota enforcement
  - [ ] Test orphan detection/cleanup

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

**Status**: ⬜ Not Started

**Depends on**: Phase 3

### Tasks

- [ ] **5.1 Tag Model**
  - [ ] Create `app/models/tag.py` (spec lines 174-183)
  - [ ] Add indexes on name, slug
  - [ ] Track post_count (denormalized)

- [ ] **5.2 PostTag Association**
  - [ ] Create association table (spec lines 185-190)
  - [ ] Set up relationships in Post and Tag models

- [ ] **5.3 Tag Schemas**
  - [ ] Create `app/schemas/tag.py`
  - [ ] `TagCreate` - Create tag data
  - [ ] `TagUpdate` - Update tag data
  - [ ] `TagResponse` - API response
  - [ ] `TagWithPosts` - Tag with post list

- [ ] **5.4 Tag Service**
  - [ ] Create `app/services/tag_service.py`
  - [ ] `create_tag()` - Create with slug
  - [ ] `update_tag()` - Update metadata
  - [ ] `delete_tag()` - Remove (with options)
  - [ ] `get_tag_by_slug()` - Lookup
  - [ ] `list_tags()` - All tags
  - [ ] `get_important_tags()` - Featured tags
  - [ ] `update_post_count()` - Recalculate counts

- [ ] **5.5 Post-Tag Integration**
  - [ ] Update PostService to handle tags
  - [ ] Create tags on-the-fly when tagging posts
  - [ ] Auto-update tag counts
  - [ ] Tag cloud generation

- [ ] **5.6 Tag API Endpoints**
  - [ ] Create `app/api/tags.py`
  - [ ] `GET /api/tags` - List all tags
  - [ ] `POST /api/tags` - Create tag
  - [ ] `GET /api/tags/{id}` - Get tag
  - [ ] `PUT /api/tags/{id}` - Update tag
  - [ ] `DELETE /api/tags/{id}` - Delete tag
  - [ ] `GET /api/tags/{slug}/posts` - Posts by tag

- [ ] **5.7 Tag Tests**
  - [ ] Test CRUD operations
  - [ ] Test post-tag relationships
  - [ ] Test count updates
  - [ ] Test on-the-fly creation
  - [ ] Test tag deletion behavior

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

## Phase 6: Admin Interface

**Goal**: Build admin dashboard and management UI

**Status**: ⬜ Not Started

**Depends on**: Phases 3, 4, 5

### Tasks

- [ ] **6.1 Base Templates**
  - [ ] Create `app/templates/base.html`
  - [ ] Create `app/templates/admin/base.html`
  - [ ] Set up Jinja2 environment
  - [ ] Add common macros (forms, pagination)

- [ ] **6.2 Admin Static Assets**
  - [ ] Create `app/static/css/admin.css`
  - [ ] Create `app/static/js/admin.js`
  - [ ] Add minimal JS for interactions
  - [ ] Style forms, tables, buttons

- [ ] **6.3 Login Page**
  - [ ] Create `app/templates/admin/login.html`
  - [ ] Implement login form
  - [ ] Handle errors/validation
  - [ ] Redirect after login

- [ ] **6.4 Dashboard**
  - [ ] Create `app/templates/admin/dashboard.html`
  - [ ] Display stats (posts, drafts, views)
  - [ ] Recent posts list
  - [ ] Storage usage display
  - [ ] Active sessions

- [ ] **6.5 Post Editor**
  - [ ] Create `app/templates/admin/post_edit.html`
  - [ ] Form fields (title, content, tags, status)
  - [ ] Image upload widget
  - [ ] Insert image into content
  - [ ] Save draft (Ctrl+S)
  - [ ] Preview button
  - [ ] Publish/Delete actions

- [ ] **6.6 Posts List**
  - [ ] Create `app/templates/admin/posts_list.html`
  - [ ] Table with all posts
  - [ ] Filter by status
  - [ ] Search posts
  - [ ] Bulk actions (optional)

- [ ] **6.7 Tag Manager**
  - [ ] Create `app/templates/admin/tags.html`
  - [ ] List all tags with counts
  - [ ] Edit tag details
  - [ ] Delete with confirmation
  - [ ] Mark as important

- [ ] **6.8 Media Library**
  - [ ] Create `app/templates/admin/media.html`
  - [ ] Grid view of uploads
  - [ ] Filter by type
  - [ ] Search by filename
  - [ ] Delete files
  - [ ] Copy URL button
  - [ ] Upload modal

- [ ] **6.9 Admin Routes**
  - [ ] Create `app/api/admin.py` (HTML routes)
  - [ ] `GET /admin/` - Dashboard
  - [ ] `GET /admin/login` - Login page
  - [ ] `GET /admin/posts` - Posts list
  - [ ] `GET /admin/posts/new` - New post
  - [ ] `GET /admin/posts/{id}` - Edit post
  - [ ] `GET /admin/tags` - Tag manager
  - [ ] `GET /admin/media` - Media library

- [ ] **6.10 Admin Tests**
  - [ ] Test page loads with auth
  - [ ] Test redirect without auth
  - [ ] Test form submissions
  - [ ] Test error handling

### Deliverables

1. Functional login page
2. Dashboard with statistics
3. Post editor with preview
4. Posts list with filters
5. Tag management interface
6. Media library with upload
7. Responsive admin layout

### Validation Criteria

```bash
# Access login page
curl http://localhost:8000/admin/login  # Returns HTML

# Dashboard requires auth
curl http://localhost:8000/admin/  # Redirects to login

# With auth, dashboard loads
curl http://localhost:8000/admin/ -H "Cookie: session=<token>"
```

---

## Phase 7: Public Frontend

**Goal**: Build public-facing pages for viewing content

**Status**: ⬜ Not Started

**Depends on**: Phases 3, 5

### Tasks

- [ ] **7.1 Public Base Template**
  - [ ] Create `app/templates/public/base.html`
  - [ ] Header with navigation
  - [ ] Footer with links
  - [ ] Meta tags for SEO

- [ ] **7.2 Public Styles**
  - [ ] Create `app/static/css/main.css`
  - [ ] Typography (readable fonts)
  - [ ] Layout (responsive grid)
  - [ ] Image styling
  - [ ] Pagination styles

- [ ] **7.3 Homepage**
  - [ ] Create `app/templates/public/index.html`
  - [ ] List recent posts (paginated)
  - [ ] Post cards (thumbnail, title, excerpt, date)
  - [ ] Sidebar with tag cloud
  - [ ] Pagination controls

- [ ] **7.4 Single Post View**
  - [ ] Create `app/templates/public/post.html`
  - [ ] Full post content
  - [ ] Featured image
  - [ ] Tags list
  - [ ] Published date
  - [ ] View counter
  - [ ] Previous/Next navigation

- [ ] **7.5 Tag Archive**
  - [ ] Create `app/templates/public/tag.html`
  - [ ] Tag description header
  - [ ] Posts with this tag
  - [ ] Pagination

- [ ] **7.6 Gallery View**
  - [ ] Create `app/templates/public/gallery.html`
  - [ ] Grid of post thumbnails
  - [ ] Filter by tag
  - [ ] Optional lightbox

- [ ] **7.7 Public Routes**
  - [ ] Add routes to `app/main.py`
  - [ ] `GET /` - Homepage
  - [ ] `GET /posts/{slug}` - Single post
  - [ ] `GET /tag/{slug}` - Tag archive
  - [ ] `GET /gallery` - Gallery view

- [ ] **7.8 View Counting**
  - [ ] Increment on page load
  - [ ] Avoid counting admin views
  - [ ] Batch updates (optional)

- [ ] **7.9 Public Tests**
  - [ ] Test homepage loads
  - [ ] Test post page loads
  - [ ] Test 404 for missing posts
  - [ ] Test pagination
  - [ ] Test tag filtering

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

**Status**: ⬜ Not Started

**Depends on**: Phase 7

### Tasks

- [ ] **8.1 RSS Feed**
  - [ ] Create `app/templates/public/rss.xml`
  - [ ] Include last 20 published posts
  - [ ] Full content or excerpt (configurable)
  - [ ] Media enclosures for images
  - [ ] Proper pubDate formatting

- [ ] **8.2 RSS Route**
  - [ ] `GET /feed.xml` - RSS feed
  - [ ] Set correct Content-Type
  - [ ] Add caching headers

- [ ] **8.3 Sitemap**
  - [ ] Create `app/templates/public/sitemap.xml`
  - [ ] List all public pages
  - [ ] Include lastmod dates
  - [ ] Priority settings

- [ ] **8.4 Robots.txt**
  - [ ] Create static `robots.txt`
  - [ ] Allow/disallow rules
  - [ ] Point to sitemap

- [ ] **8.5 Meta Tags**
  - [ ] Add Open Graph tags
  - [ ] Add Twitter Card tags
  - [ ] Dynamic meta descriptions
  - [ ] Canonical URLs

- [ ] **8.6 SEO Routes**
  - [ ] `GET /sitemap.xml` - Sitemap
  - [ ] `GET /robots.txt` - Robots file

- [ ] **8.7 RSS/SEO Tests**
  - [ ] Test RSS valid XML
  - [ ] Test sitemap valid XML
  - [ ] Test meta tags present

### Deliverables

1. Valid RSS feed with posts
2. Sitemap for search engines
3. robots.txt
4. Open Graph/Twitter meta tags
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

**Status**: ⬜ Not Started

**Depends on**: Phase 7

### Tasks

- [ ] **9.1 CSS Variables**
  - [ ] Define theme variables in `main.css`
  - [ ] Colors, backgrounds, borders
  - [ ] Typography colors
  - [ ] Shadow styles

- [ ] **9.2 Dark Theme**
  - [ ] Create `app/templates/themes/dark/styles.css`
  - [ ] Dark color palette
  - [ ] Adjusted contrasts

- [ ] **9.3 Light Theme**
  - [ ] Create `app/templates/themes/light/styles.css`
  - [ ] Light color palette
  - [ ] Clean aesthetics

- [ ] **9.4 Theme JavaScript**
  - [ ] Create `app/static/js/theme.js`
  - [ ] Detect system preference
  - [ ] Toggle theme
  - [ ] Persist preference (localStorage)
  - [ ] Apply on page load (no flash)

- [ ] **9.5 Theme Switcher UI**
  - [ ] Add toggle in header
  - [ ] Icon changes with theme
  - [ ] Smooth transitions

- [ ] **9.6 Admin Theme Support**
  - [ ] Apply theming to admin
  - [ ] Consistent with public

- [ ] **9.7 Color Scheme Meta**
  - [ ] Update `<meta name="color-scheme">`
  - [ ] Browser UI adaptation

- [ ] **9.8 Theme Tests**
  - [ ] Test theme toggle
  - [ ] Test persistence
  - [ ] Test system preference

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

**Status**: ⬜ Not Started

**Depends on**: Phase 7

### Tasks

- [ ] **10.1 Cache Service**
  - [ ] Create `app/services/cache_service.py`
  - [ ] Implement `FileCache` class (spec lines 379-385)
  - [ ] `get(key)` - Retrieve cached value
  - [ ] `set(key, value, ttl)` - Store with expiry
  - [ ] `delete(key)` - Remove specific key
  - [ ] `clear_all()` - Clear entire cache
  - [ ] `clear_pattern(pattern)` - Clear by pattern

- [ ] **10.2 Cache Storage**
  - [ ] Store in `/data/cache/pages/`
  - [ ] Use hashed keys for filenames
  - [ ] Include metadata (expiry, created)

- [ ] **10.3 Page Caching**
  - [ ] Cache rendered homepage
  - [ ] Cache tag archive pages
  - [ ] Cache RSS feed
  - [ ] Configurable TTL

- [ ] **10.4 Cache Invalidation**
  - [ ] Invalidate on post publish/update
  - [ ] Invalidate on tag edit
  - [ ] Invalidate on settings change
  - [ ] Manual cache clear endpoint

- [ ] **10.5 Database Optimization**
  - [ ] Add proper indexes
  - [ ] Optimize common queries
  - [ ] Implement eager loading
  - [ ] Add VACUUM schedule

- [ ] **10.6 Static Asset Caching**
  - [ ] Add cache headers
  - [ ] ETags for static files
  - [ ] Browser caching

- [ ] **10.7 Image Optimization**
  - [ ] Lazy loading on frontend
  - [ ] Responsive images (srcset)
  - [ ] WebP support (optional)

- [ ] **10.8 Cache Tests**
  - [ ] Test cache hit/miss
  - [ ] Test invalidation
  - [ ] Test TTL expiry

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

**Status**: ⬜ Not Started

**Depends on**: Phase 10

### Tasks

- [ ] **11.1 APScheduler Setup**
  - [ ] Configure scheduler in `app/main.py`
  - [ ] Use async scheduler
  - [ ] Handle graceful shutdown

- [ ] **11.2 Session Cleanup Task**
  - [ ] Schedule hourly
  - [ ] Delete expired sessions
  - [ ] Log cleanup results

- [ ] **11.3 View Count Flush**
  - [ ] Schedule every 30 minutes
  - [ ] Flush in-memory counts to DB
  - [ ] Handle concurrent access

- [ ] **11.4 Backup Service**
  - [ ] Create `app/services/backup_service.py`
  - [ ] SQLite `.backup` command
  - [ ] Media file backup
  - [ ] Compress archive
  - [ ] Configurable retention

- [ ] **11.5 Daily Backup Task**
  - [ ] Schedule daily (configurable time)
  - [ ] Execute backup service
  - [ ] Rotate old backups
  - [ ] Optional S3 upload

- [ ] **11.6 Backup Scripts**
  - [ ] Create `scripts/backup.sh` (spec lines 1021-1052)
  - [ ] Create `scripts/restore.sh` (spec lines 1055-1086)
  - [ ] Document usage

- [ ] **11.7 Manual Backup Endpoint**
  - [ ] `POST /api/system/backup` - Trigger backup
  - [ ] Return backup file path
  - [ ] Admin only

- [ ] **11.8 Task Tests**
  - [ ] Test scheduler startup
  - [ ] Test backup creation
  - [ ] Test restore procedure

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

**Goal**: Implement blog settings and admin system tools

**Status**: ⬜ Not Started

**Depends on**: Phase 6

### Tasks

- [ ] **12.1 BlogSettings Model**
  - [ ] Create `app/models/settings.py` (spec lines 233-239)
  - [ ] Key-value storage
  - [ ] Type handling (string, int, bool, json)

- [ ] **12.2 Settings Service**
  - [ ] Create `app/services/settings_service.py`
  - [ ] `get_setting(key)` - Get single setting
  - [ ] `get_all_settings()` - Get all
  - [ ] `update_setting(key, value)` - Update
  - [ ] `update_settings(dict)` - Bulk update
  - [ ] Merge with env defaults

- [ ] **12.3 Settings API**
  - [ ] `GET /api/settings` - Get all
  - [ ] `PUT /api/settings` - Update all
  - [ ] `GET /api/settings/{key}` - Get one

- [ ] **12.4 Settings Page**
  - [ ] Create `app/templates/admin/settings.html`
  - [ ] All settings per spec (lines 438-453)
  - [ ] Form validation
  - [ ] Save feedback

- [ ] **12.5 System Stats**
  - [ ] Implement stats collection
  - [ ] Database size
  - [ ] Storage usage
  - [ ] Cache stats
  - [ ] Active sessions

- [ ] **12.6 Log Viewer**
  - [ ] Create log viewing service
  - [ ] Read last N lines
  - [ ] Filter by level
  - [ ] Stream new logs (optional)

- [ ] **12.7 System Tools Page**
  - [ ] Create `app/templates/admin/system.html`
  - [ ] View logs
  - [ ] Cache statistics
  - [ ] Clear cache button
  - [ ] Database stats
  - [ ] Trigger backup

- [ ] **12.8 System API**
  - [ ] `GET /api/system/stats` - Statistics
  - [ ] `GET /api/system/logs` - View logs
  - [ ] `POST /api/system/cache/clear` - Clear cache

- [ ] **12.9 Settings/System Tests**
  - [ ] Test settings CRUD
  - [ ] Test cache clear
  - [ ] Test stats collection

### Deliverables

1. Blog settings management
2. Settings admin page
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

## Phase 13: CI/CD & Deployment

**Goal**: Set up automated testing, building, and deployment

**Status**: ⬜ Not Started

**Depends on**: All previous phases

### Tasks

- [ ] **13.1 GitHub Actions Workflow**
  - [ ] Create `.github/workflows/deploy.yml` (spec lines 687-799)
  - [ ] Test job (lint, type check, tests)
  - [ ] Build job (Docker image)
  - [ ] Deploy job (production)

- [ ] **13.2 Test Job**
  - [ ] Set up Python
  - [ ] Install dependencies
  - [ ] Run ruff
  - [ ] Run mypy
  - [ ] Run pytest with coverage
  - [ ] Upload coverage report

- [ ] **13.3 Build Job**
  - [ ] Build Docker image
  - [ ] Push to GitHub Container Registry
  - [ ] Tag with version/SHA
  - [ ] Cache layers

- [ ] **13.4 Deploy Job**
  - [ ] SSH to production server
  - [ ] Pull new image
  - [ ] Run migrations (if any)
  - [ ] Restart service
  - [ ] Health check

- [ ] **13.5 Production Docker Compose**
  - [ ] Create `docker-compose.override.yml` (spec lines 654-682)
  - [ ] Production volume mounts
  - [ ] Optional nginx config

- [ ] **13.6 Environment Configuration**
  - [ ] Document required secrets
  - [ ] Set up GitHub secrets
  - [ ] Production .env template

- [ ] **13.7 Health Checks**
  - [ ] Verify deployment succeeded
  - [ ] Rollback on failure (optional)
  - [ ] Notify on completion

- [ ] **13.8 Documentation**
  - [ ] Update README with deploy instructions
  - [ ] Document GitHub secrets needed
  - [ ] Deployment checklist (spec lines 932-955)

- [ ] **13.9 CI/CD Tests**
  - [ ] Test workflow syntax
  - [ ] Test local with act (optional)
  - [ ] Verify full pipeline works

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
| | | | |

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
    Phase 6 (Admin) ◄──────────────┘
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
