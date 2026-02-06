# Photo Blog Engine - Technical Specification

## Project Overview

Build a lightweight, professional-grade personal photo blog engine using FastAPI, SQLite, and Docker. The application should be self-contained in a single Docker container with external volume storage for data persistence.

## Technology Stack

### Core Technologies
- **Backend**: FastAPI (Python 3.12+)
- **Database**: SQLite (file-based, no separate server)
- **Image Processing**: Pillow (PIL)
- **Background Tasks**: APScheduler (in-process, no Celery)
- **ASGI Server**: Uvicorn
- **ORM**: SQLAlchemy 2.0+
- **Templates**: Jinja2 (server-side rendering)
- **Authentication**: FastAPI security utilities + passlib

### Development Tools
- **Testing**: pytest, pytest-asyncio
- **Linting**: ruff
- **Type Checking**: mypy
- **Dependency Management**: Poetry or pip-tools

## Architecture Design

### Single Container Approach
- All services run in one optimized Docker container
- No microservices complexity
- No Redis, PostgreSQL, or separate message queues
- Lightweight final image (~200MB)

### Directory Structure

```
photo-blog/
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI application entry
│   ├── config.py               # Configuration management
│   ├── database.py             # SQLAlchemy setup
│   ├── dependencies.py         # FastAPI dependencies
│   ├── models/
│   │   ├── __init__.py
│   │   ├── post.py            # Post model
│   │   ├── tag.py             # Tag model
│   │   ├── media.py           # Media file metadata
│   │   ├── user.py            # User/session model
│   │   └── settings.py        # Blog settings model
│   ├── schemas/
│   │   ├── __init__.py
│   │   ├── post.py            # Pydantic schemas
│   │   ├── tag.py
│   │   ├── media.py
│   │   └── auth.py
│   ├── api/
│   │   ├── __init__.py
│   │   ├── posts.py           # Post CRUD endpoints
│   │   ├── tags.py            # Tag management
│   │   ├── media.py           # Media upload/management
│   │   ├── auth.py            # Authentication
│   │   └── light.py           # Light endpoints
│   ├── services/
│   │   ├── __init__.py
│   │   ├── post_service.py    # Business logic for posts
│   │   ├── media_service.py   # Image processing, thumbnails
│   │   ├── auth_service.py    # Authentication logic
│   │   ├── cache_service.py   # File-based caching
│   │   └── backup_service.py  # Backup utilities
│   ├── templates/
│   │   ├── base.html          # Base template
│   │   ├── light/
│   │   │   ├── login.html
│   │   │   ├── dashboard.html
│   │   │   ├── post_edit.html
│   │   │   ├── posts_list.html
│   │   │   ├── tags.html
│   │   │   ├── media.html
│   │   │   └── settings.html
│   │   ├── public/
│   │   │   ├── index.html     # Homepage
│   │   │   ├── post.html      # Single post view
│   │   │   ├── tag.html       # Tag archive
│   │   │   ├── gallery.html   # Gallery view
│   │   │   └── rss.xml        # RSS feed template
│   │   └── themes/
│   │       ├── dark/
│   │       │   └── styles.css
│   │       └── light/
│   │           └── styles.css
│   ├── static/
│   │   ├── css/
│   │   │   └── main.css       # Common styles, theme switching
│   │   ├── js/
│   │   │   ├── light.js       # Light UI interactions
│   │   │   └── theme.js       # Theme detection/switching
│   │   └── images/
│   └── utils/
│       ├── __init__.py
│       ├── image_processor.py # Image resize, thumbnail generation
│       ├── formatters.py      # Text formatters (Markdown, HTML)
│       └── validators.py      # Input validation
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   ├── test_api/
│   ├── test_services/
│   └── test_models/
├── scripts/
│   ├── init_db.py             # Database initialization
│   ├── backup.sh              # Backup script
│   └── restore.sh             # Restore script
├── .github/
│   └── workflows/
│       └── deploy.yml         # CI/CD pipeline
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── requirements.txt           # or pyproject.toml
├── README.md
└── .gitignore
```

### Data Volume Structure

```
/data/                          # Mounted external volume
├── blog.db                     # SQLite database
├── media/
│   ├── originals/              # Original uploaded files
│   │   └── YYYY/MM/            # Organized by date
│   ├── thumbnails/             # Generated thumbnails (180x120)
│   │   └── YYYY/MM/
│   └── avatars/                # User avatars (80x80)
├── cache/                      # File-based cache
│   ├── pages/
│   ├── feeds/
│   └── fragments/
├── logs/
│   ├── app.log
│   ├── error.log
│   └── debug.log
├── backups/                    # Local backups
│   └── YYYY-MM-DD/
└── config/
    └── settings.json           # Runtime configuration
```

## Database Schema

### SQLAlchemy Models

#### Post Model
```python
- id: Integer (Primary Key)
- title: String(500)
- slug: String(200, unique, indexed)
- content: Text
- excerpt: Text (auto-generated or manual)
- formatter: String(50) default='markdown'  # markdown, html, raw
- status: Enum('draft', 'published', 'hidden')
- is_featured: Boolean default=False
- view_count: Integer default=0
- published_at: DateTime (nullable, timezone-aware)
- created_at: DateTime (auto)
- updated_at: DateTime (auto)
- author_id: Integer (FK to User)
- thumbnail_path: String(500, nullable)
- custom_url: String(200, nullable, unique)  # Alias feature
- meta_description: String(300, nullable)
```

#### Tag Model
```python
- id: Integer (Primary Key)
- name: String(100, unique, indexed)
- slug: String(100, unique, indexed)
- description: Text (nullable)
- custom_url: String(200, nullable)
- is_important: Boolean default=False
- post_count: Integer default=0 (denormalized)
- created_at: DateTime
```

#### PostTag Association (Many-to-Many)
```python
- post_id: Integer (FK)
- tag_id: Integer (FK)
- Primary Key: (post_id, tag_id)
```

#### Media Model
```python
- id: Integer (Primary Key)
- filename: String(500)
- original_path: String(1000)
- thumbnail_path: String(1000, nullable)
- file_type: Enum('image', 'video', 'audio')
- mime_type: String(100)
- file_size: Integer (bytes)
- width: Integer (nullable)
- height: Integer (nullable)
- post_id: Integer (FK, nullable)  # Can be unattached
- uploaded_at: DateTime
- checksum: String(64)  # SHA256 for deduplication
```

#### User Model (Single User)
```python
- id: Integer (Primary Key)
- username: String(50, unique)
- email: String(200)
- password_hash: String(200)
- display_name: String(100)
- avatar_path: String(500, nullable)
- created_at: DateTime
- last_login: DateTime (nullable)
```

#### Session Model
```python
- id: Integer (Primary Key)
- user_id: Integer (FK)
- token: String(200, unique, indexed)
- ip_address: String(45)
- user_agent: String(500)
- location: String(200, nullable)  # Rough location from IP
- created_at: DateTime
- expires_at: DateTime
- last_activity: DateTime
```

#### BlogSettings Model (Key-Value)
```python
- key: String(100, Primary Key)
- value: Text
- value_type: String(20)  # string, int, bool, json
- updated_at: DateTime
```

## Core Features Implementation

### 1. Post Management

#### Create/Edit Post
- Rich text editor support (can use simple textarea + preview)
- Auto-save functionality (localStorage backup + periodic API save)
- Draft management
- Status transitions: draft → published, published → hidden, published → draft
- Automatic slug generation from title (transliteration for non-ASCII)
- Thumbnail selection from uploaded images
- Custom URL aliases
- Timezone-aware timestamps

#### Post Visibility
- **Draft**: Only visible to light
- **Published**: Public, appears in feeds
- **Hidden**: Not in lists/feeds but accessible via direct URL

#### Preview Links
- Generate secret tokens for draft preview
- Token-based URL: `/preview/{token}`
- Expire after 7 days or manual revoke

### 2. Media Management

#### Image Upload
- Drag-and-drop support (HTML5)
- Multiple file upload
- Accept: PNG, JPG, GIF, SVG, MP4, MOV, MP3
- File size validation (configurable, default 10MB per file)
- Storage quota check before upload

#### Image Processing Pipeline
```python
async def process_image(file):
    1. Validate format and size
    2. Generate checksum (deduplicate if exists)
    3. Save original to /data/media/originals/YYYY/MM/
    4. Generate thumbnail (180x120, maintain aspect ratio)
    5. Optionally resize original if > max_width (default 2560px)
    6. Save metadata to database
    7. Return media object
```

#### Thumbnail Generation
- Use Pillow's `Image.thumbnail()` method
- Maintain aspect ratio
- JPEG quality: configurable (default 85)
- Progressive JPEG for web optimization

#### Storage Management
- Track total storage usage
- Display quota usage in light
- Cleanup orphaned files (files not linked to any post)
- Bulk delete unused media

### 3. Tag System

#### Tag Management
- Create tags on-the-fly when creating posts
- Edit tag metadata (description, custom URL)
- Delete tags (optionally remove from posts or orphan posts)
- Mark tags as "important" (featured in tag cloud)
- Auto-update post count when posts are tagged/untagged

#### Tag Pages
- List all posts with specific tag
- Pagination
- Tag description at top of page
- Custom meta description for SEO

### 4. Authentication & Sessions

#### Login System
- Username/password authentication
- Password hashing: bcrypt or Argon2
- Session token (JWT or random token)
- Cookie-based session (httpOnly, secure, sameSite)
- "Remember me" option (extended expiry)
- "Public computer" mode (session-only cookie)

#### Session Management
- Track active sessions (device, browser, IP, location)
- Display session list in light
- Terminate individual sessions
- Terminate all other sessions

#### Password Management
- Change password (requires current password)
- Password reset via email (optional, can implement later)
- Minimum password requirements

### 5. Theming System

#### Theme Structure
- Two built-in themes: dark, light
- CSS-based theming (CSS custom properties)
- System preference detection: `prefers-color-scheme`
- User preference override (saved to localStorage or database)

#### Theme Switching Logic
```javascript
1. Check user preference in settings
2. If "auto": use system preference
3. If "dark" or "light": override system
4. Apply theme class to <html> element
5. Update <meta name="color-scheme"> for browser UI
```

#### Theme Files
- `/static/css/main.css` - Base styles
- `/templates/themes/dark/styles.css` - Dark theme variables
- `/templates/themes/light/styles.css` - Light theme variables

### 6. RSS/Atom Feed

#### Feed Generation
- Endpoint: `/feed.xml` or `/rss`
- Include last 20 published posts (configurable)
- Full content or excerpt (configurable)
- Media enclosures for images
- Proper pubDate and updated fields
- Cache feed XML (regenerate on post publish/update)

### 7. Caching Strategy

#### File-Based Caching
- Store rendered HTML in `/data/cache/pages/`
- Cache key: URL + query params hash
- Invalidation triggers:
  - Post publish/update/delete
  - Tag edit
  - Settings change
  - Manual cache clear

#### Cache Implementation
```python
class FileCache:
    - get(key) -> Optional[str]
    - set(key, value, ttl=3600)
    - delete(key)
    - clear_all()
    - clear_pattern(pattern)
```

### 8. Background Tasks (APScheduler)

#### Scheduled Tasks
```python
@scheduler.scheduled_job('interval', hours=24)
async def daily_backup():
    # SQLite .backup command
    # Compress /data to archive
    # Upload to external storage (optional)

@scheduler.scheduled_job('interval', hours=1)
async def cleanup_old_sessions():
    # Delete expired sessions

@scheduler.scheduled_job('interval', minutes=30)
async def update_view_counts():
    # Flush in-memory view counts to database
```

### 9. Light Interface

#### Dashboard
- Quick stats: total posts, drafts, published, view counts
- Recent posts list
- Storage usage
- Active sessions

#### Post Editor
- Form fields: title, content, tags, status, custom URL
- Image upload widget (drag-and-drop)
- Insert image into content (markdown or HTML)
- Save draft (Ctrl+S / Cmd+S)
- Publish button
- Preview in new tab
- Delete post (with confirmation)

#### Tag Manager
- List all tags with post counts
- Edit tag details
- Delete tag (with warning if posts exist)
- Mark as important

#### Media Library
- Grid view of all uploaded media
- Filter by type (image/video/audio)
- Search by filename
- Delete files
- View file details (size, dimensions, upload date)
- Copy URL to clipboard

#### Settings Page
```
- Blog title
- Blog subtitle/tagline
- Author name
- Author email
- Meta description (SEO)
- Posts per page (10-100)
- Language (en, fr, es, ro, pt, it, de)
- Theme (auto, dark, light)
- Show view counts (yes/no)
- Max image size (px)
- JPEG quality (1-100)
- Storage quota (MB)
- Force HTTPS (yes/no)
- Google Analytics ID (optional)
```

#### System Tools ("Underhood")
- View logs (app.log, error.log)
- Cache statistics (size, hit rate)
- Clear cache (all or specific patterns)
- Database stats (file size, table row counts)
- Force backup now

### 10. Public Frontend

#### Homepage
- List recent posts (paginated)
- Each post shows: thumbnail, title, excerpt, tags, date, view count
- **Video Previews**: Automatic video playback on hover for post cards containing video content.
- Sidebar: tag cloud, recent posts, search (optional)

#### Single Post View
- Full post content
- Featured image (if set)
- Embedded media (images, videos, audio)
- Tags list
- Previous/Next post navigation
- View counter (increments on page load)
- Share buttons (optional)
- **Reading Progress**: Visual indicator showing how much of the article has been read.
- **Code Utilities**: "Copy to clipboard" functionality for all code blocks.

#### Immersive Mode
- **Automatic Activation**: Triggered for posts without substantial text content (photo-centric).
- **Full-Screen Layout**: Content fills the entire viewport, minimizing distractions.
- **Interactive UI**: Interface elements (header, footer, tags) automatically hide during inactivity and reappear on mouse movement or touch.
- **Media Focus**: High-resolution display of images and videos with responsive scaling.

#### AJAX Navigation
- **SPA Experience**: Seamless transitions between posts and pages without full page reloads.
- **JSON API**: Efficient data fetching for post content.
- **Browser History**: Proper `pushState` integration to maintain shareable URLs and back-button functionality.
- **Fallback Support**: Robust graceful degradation to standard HTML navigation if AJAX fails.

#### Gesture Navigation
- **Touch Support**: Swipe left/right to navigate between posts on mobile and tablet devices.
- **Carousel Gestures**: Swipe support for image carousels within posts.
- **Vertical Swipe**: Intelligent vertical swipe detection to allow natural scrolling while maintaining navigation functionality.
- **Visual Consistency**: Optimized background colors (`var(--bg-primary)`) to ensure seamless visual transitions during overscroll and gesture interactions.

#### Quick Post Creation (Drag-and-Drop)
- **Logged-in User Feature**: Available only when authenticated, seamlessly integrates content creation into browsing.
- **Global Drop Zone**: Drag any image file onto any public page to instantly create a new post.
- **Visual Feedback**: Full-screen overlay appears during drag operation with upload status indicators.
- **Automatic Upload**: Image is uploaded via `/api/media/upload` endpoint without leaving the current page.
- **Seamless Transition**: Automatically redirects to `/light/posts/new` with:
  - Pre-populated markdown image reference in content
  - Media preview displayed
  - Ready-to-publish post editor
- **Error Handling**: Graceful error messages for invalid file types or upload failures.
- **Implementation**:
  - `initDragDropPostCreation()` in `app/static/js/main.js`
  - Drop zone overlay in `app/templates/public/base.html`
  - Styles in `app/static/css/main.css`
  - Post editor integration in `app/api/light.py` (new_post endpoint)

#### Gallery View
- Grid of post thumbnails
- Filter by tag
- Lightbox for full-size images (optional)

#### Search (Optional Phase 2)
- SQLite FTS5 full-text search
- Search in title and content
- Results page with excerpts

## Configuration Management

### Environment Variables (.env)
```bash
# Application
APP_NAME=PhotoBlog
APP_ENV=production  # development, production
DEBUG=false
SECRET_KEY=your-secret-key-here

# Server
HOST=0.0.0.0
PORT=8000

# Database
DATABASE_URL=sqlite:////data/blog.db

# Storage
STORAGE_PATH=/data
MAX_UPLOAD_SIZE_MB=10
STORAGE_QUOTA_MB=5000
MAX_IMAGE_WIDTH=2560
JPEG_QUALITY=85
THUMBNAIL_SIZE=180x120
AVATAR_SIZE=80x80

# Blog Settings (defaults, can be overridden in DB)
BLOG_TITLE=My Photo Blog
BLOG_SUBTITLE=A personal photography journal
AUTHOR_NAME=Photographer
AUTHOR_EMAIL=author@example.com
POSTS_PER_PAGE=10
DEFAULT_LANGUAGE=en
DEFAULT_THEME=auto

# Security
PASSWORD_MIN_LENGTH=8
SESSION_EXPIRY_HOURS=720  # 30 days
SESSION_EXPIRY_PUBLIC_HOURS=2

# Features
ENABLE_ANALYTICS=false
GOOGLE_ANALYTICS_ID=
FORCE_HTTPS=true

# Backup (optional)
BACKUP_ENABLED=true
BACKUP_SCHEDULE=0 2 * * *  # Daily at 2 AM
BACKUP_RETENTION_DAYS=30
BACKUP_UPLOAD_S3=false
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=
```

### Runtime Settings (Database)
Stored in `BlogSettings` model for light-editable configuration.

## Docker Setup

### Dockerfile
```dockerfile
FROM python:3.12-slim as builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Runtime stage
FROM python:3.12-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from builder
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH

# Copy application
COPY app/ /app/app/
COPY scripts/ /app/scripts/

# Create data directory structure
RUN mkdir -p /data/media/originals \
    /data/media/thumbnails \
    /data/media/avatars \
    /data/cache/pages \
    /data/cache/feeds \
    /data/logs \
    /data/backups \
    /data/config

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Non-root user
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app /data
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### docker-compose.yml
```yaml
version: '3.8'

services:
  blog:
    build: .
    image: photo-blog:latest
    container_name: photo-blog
    restart: unless-stopped
    ports:
      - "8000:8000"
    volumes:
      - blog-data:/data
    env_file:
      - .env
    environment:
      - TZ=America/Montreal
    networks:
      - blog-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s

volumes:
  blog-data:
    driver: local
    # For production, use named volume or mount point
    # driver_opts:
    #   type: none
    #   device: /mnt/blog-data
    #   o: bind

networks:
  blog-network:
    driver: bridge
```

### Production docker-compose.override.yml
```yaml
version: '3.8'

services:
  blog:
    image: ghcr.io/username/photo-blog:latest  # Pull from registry
    restart: always
    volumes:
      - /mnt/blog-data:/data  # Production volume mount
    labels:
      - "com.centurylinklabs.watchtower.enable=true"  # Auto-update support

  # Optional: Nginx reverse proxy
  nginx:
    image: nginx:alpine
    container_name: photo-blog-nginx
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
      - blog-data:/data:ro  # Serve static files
    depends_on:
      - blog
    networks:
      - blog-network
```

## CI/CD Pipeline (GitHub Actions)

### .github/workflows/deploy.yml
```yaml
name: Build and Deploy

on:
  push:
    branches: [main]
    tags:
      - 'v*'
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          pip install pytest pytest-asyncio pytest-cov

      - name: Run linting
        run: |
          pip install ruff
          ruff check app/

      - name: Run tests
        run: |
          pytest tests/ --cov=app --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage.xml

  build:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache
          cache-to: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy to Production
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd /opt/photo-blog
            docker-compose pull
            docker-compose up -d
            docker-compose exec -T blog python scripts/init_db.py

      - name: Health Check
        run: |
          sleep 10
          curl -f https://yourblog.com/health || exit 1

      - name: Notify Success
        if: success()
        run: echo "Deployment successful!"

      - name: Notify Failure
        if: failure()
        run: echo "Deployment failed!"
```

## API Endpoints

### Authentication
```
POST   /api/auth/login          # Login
POST   /api/auth/logout         # Logout
GET    /api/auth/me             # Get current user
POST   /api/auth/change-password
GET    /api/auth/sessions       # List sessions
DELETE /api/auth/sessions/{id}  # Terminate session
```

### Posts
```
GET    /api/posts               # List posts (with filters)
POST   /api/posts               # Create post
GET    /api/posts/{id}          # Get post
PUT    /api/posts/{id}          # Update post
DELETE /api/posts/{id}          # Delete post
GET    /api/posts/slug/{slug}   # Get by slug
POST   /api/posts/{id}/publish  # Publish draft
POST   /api/posts/{id}/withdraw # Withdraw to draft
GET    /api/posts/{id}/preview  # Generate preview link
```

### Tags
```
GET    /api/tags                # List all tags
POST   /api/tags                # Create tag
GET    /api/tags/{id}           # Get tag
PUT    /api/tags/{id}           # Update tag
DELETE /api/tags/{id}           # Delete tag
GET    /api/tags/{slug}/posts   # Get posts by tag
```

### Media
```
GET    /api/media               # List media files
POST   /api/media/upload        # Upload file(s)
GET    /api/media/{id}          # Get file metadata
DELETE /api/media/{id}          # Delete file
GET    /api/media/orphaned      # List orphaned files
DELETE /api/media/orphaned      # Cleanup orphaned files
```

### Settings
```
GET    /api/settings            # Get all settings
PUT    /api/settings            # Update settings
GET    /api/settings/{key}      # Get specific setting
```

### System
```
GET    /api/system/stats        # System statistics
GET    /api/system/logs         # View logs
POST   /api/system/cache/clear  # Clear cache
POST   /api/system/backup       # Trigger backup
GET    /health                  # Health check endpoint
```

### Public Routes (no auth)
```
GET    /                        # Homepage
GET    /posts/{slug}            # View post
GET    /tag/{slug}              # Tag archive
GET    /gallery                 # Gallery view
GET    /feed.xml                # RSS feed
GET    /preview/{token}         # Preview draft
GET    /sitemap.xml             # Sitemap
GET    /robots.txt              # Robots.txt
```

## Security Considerations

### Input Validation
- Validate all file uploads (type, size, content)
- Sanitize HTML content if allowing raw HTML
- SQL injection protection (use SQLAlchemy ORM, no raw queries)
- XSS protection (escape output in templates)
- CSRF protection (FastAPI CSRF middleware)

### Authentication
- Strong password hashing (bcrypt/Argon2)
- Secure session tokens
- HttpOnly, Secure, SameSite cookies
- Rate limiting on login endpoint
- Account lockout after failed attempts (optional)

### File Upload Security
- Whitelist allowed file extensions
- Validate MIME type (not just extension)
- Scan for malicious content (optional)
- Store files outside web root
- Generate random filenames (prevent directory traversal)
- Limit file sizes
- Virus scanning for production (ClamAV, optional)

### Headers
```python
# Set security headers
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; img-src 'self' data:; script-src 'self'
```

## Testing Strategy

### Unit Tests
- Test all service methods
- Test utility functions
- Mock database operations

### Integration Tests
- Test API endpoints
- Test authentication flows
- Test file upload pipeline
- Test image processing

### E2E Tests (Optional)
- Playwright or Selenium
- Test critical user journeys
- Light workflows

### Test Coverage Goal
- Aim for 80%+ code coverage
- 100% coverage for critical paths (auth, file upload)

## Deployment Checklist

### Initial Setup
1. Clone repository
2. Copy `.env.example` to `.env` and configure
3. Create external volume/mount point
4. Run `docker-compose up -d`
5. Initialize database: `docker-compose exec blog python scripts/init_db.py`
6. Create light user
7. Configure reverse proxy (Nginx/Caddy) for HTTPS
8. Set up SSL certificate (Let's Encrypt)
9. Configure DNS
10. Test health endpoint

### Production Hardening
- [ ] Change default light password
- [ ] Configure firewall (UFW/iptables)
- [ ] Set up automated backups
- [ ] Configure log rotation
- [ ] Enable fail2ban for SSH
- [ ] Set up monitoring (Uptime Kuma, Healthchecks.io)
- [ ] Configure external backup destination (S3, Backblaze B2)
- [ ] Test restore procedure
- [ ] Set up domain and SSL

### Maintenance Tasks
- Weekly: Review logs
- Monthly: Test backups
- Quarterly: Update dependencies
- As needed: Scale resources

## Performance Optimization

### Database
- Create indexes on frequently queried fields (slug, status, published_at)
- Use EXPLAIN QUERY PLAN to optimize slow queries
- Regular VACUUM for SQLite maintenance

### Caching
- Cache rendered pages (file-based or in-memory)
- Cache RSS feed
- ETags for static content
- Browser caching headers

### Image Optimization
- Lazy loading images on frontend
- Serve WebP format for supported browsers
- Use responsive images (srcset)
- Compress images on upload

### Application
- Use async/await throughout
- Connection pooling for database
- Minimize database queries (eager loading)
- Profile slow endpoints

## Monitoring & Logging

### Logging Levels
```python
DEBUG: Detailed debugging info
INFO: General informational messages
WARNING: Warning messages
ERROR: Error messages
CRITICAL: Critical errors
```

### Log Files
- `/data/logs/app.log` - All application logs
- `/data/logs/error.log` - Errors only
- `/data/logs/debug.log` - Debug logs (dev only)

### Log Rotation
```python
- Max size: 10MB per file
- Keep: 5 backup files
- Compress old logs
```

### Metrics to Track
- Request count and latency
- Error rate
- Storage usage
- Database size
- Cache hit rate
- Active sessions

## Backup & Recovery

### Backup Strategy
```bash
#!/bin/bash
# scripts/backup.sh

DATE=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_DIR="/data/backups/$DATE"

mkdir -p "$BACKUP_DIR"

# 1. SQLite backup
sqlite3 /data/blog.db ".backup '$BACKUP_DIR/blog.db'"

# 2. Media files
rsync -a /data/media/ "$BACKUP_DIR/media/"

# 3. Config
cp /data/config/settings.json "$BACKUP_DIR/"

# 4. Compress
tar -czf "$BACKUP_DIR.tar.gz" -C /data/backups "$DATE"
rm -rf "$BACKUP_DIR"

# 5. Upload to S3 (optional)
if [ "$BACKUP_UPLOAD_S3" = "true" ]; then
    aws s3 cp "$BACKUP_DIR.tar.gz" "s3://$S3_BUCKET/backups/"
fi

# 6. Cleanup old backups (keep last 30 days)
find /data/backups -name "*.tar.gz" -mtime +30 -delete

echo "Backup completed: $BACKUP_DIR.tar.gz"
```

### Restore Procedure
```bash
#!/bin/bash
# scripts/restore.sh

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: ./restore.sh <backup-file.tar.gz>"
    exit 1
fi

# 1. Stop application
docker-compose stop blog

# 2. Extract backup
tar -xzf "$BACKUP_FILE" -C /data/backups/

# 3. Restore database
RESTORE_DIR=$(basename "$BACKUP_FILE" .tar.gz)
cp "/data/backups/$RESTORE_DIR/blog.db" /data/blog.db

# 4. Restore media
rsync -a "/data/backups/$RESTORE_DIR/media/" /data/media/

# 5. Restore config
cp "/data/backups/$RESTORE_DIR/settings.json" /data/config/

# 6. Start application
docker-compose start blog

echo "Restore completed from $BACKUP_FILE"
```

## Future Enhancements (Phase 2+)

### Features to Consider
- [ ] Full-text search with FTS5
- [ ] Comments system (with moderation)
- [ ] Social media integration (auto-post to Instagram)
- [ ] Image EXIF data extraction and display
- [ ] Geolocation tagging
- [ ] Multi-language content (i18n)
- [ ] Import from other platforms (WordPress, Medium)
- [ ] Export to static site
- [ ] Webhooks for integrations
- [ ] API key management for external access
- [ ] Progressive Web App (PWA)
- [ ] Image editing tools (crop, rotate, filters)
- [ ] Video transcoding
- [ ] Audio waveform visualization
- [ ] Related posts suggestions
- [ ] Reading time estimation
- [ ] Table of contents generation
- [ ] Markdown editor with live preview
- [ ] Image galleries/albums
- [ ] Portfolio sections

## Documentation Requirements

### README.md
- Project overview
- Quick start guide
- Installation instructions
- Configuration guide
- Deployment guide
- Contributing guidelines

### API Documentation
- Auto-generated with FastAPI/Swagger
- Available at `/docs` (Swagger UI)
- Available at `/redoc` (ReDoc)

### Developer Guide
- Architecture overview
- Database schema
- Adding new features
- Testing guide
- Deployment guide

## Success Criteria

### Performance
- Page load time < 2 seconds
- API response time < 500ms
- Image upload processing < 5 seconds
- Handle 100 concurrent users

### Reliability
- 99.9% uptime
- Automated backups successful
- Zero data loss
- Successful recovery from backups

### Security
- No critical vulnerabilities
- All inputs validated
- Authentication secure
- Regular security updates

### Usability
- Intuitive light interface
- Mobile-responsive
- Accessible (WCAG 2.1 Level AA)
- Fast content creation workflow

## Additional Notes

### Development Workflow
1. Feature branch from `main`
2. Implement feature with tests
3. Run tests locally
4. Create pull request
5. CI runs tests and linting
6. Code review
7. Merge to `main`
8. Auto-deploy to production

### Version Control
- Use semantic versioning (MAJOR.MINOR.PATCH)
- Tag releases: `v1.0.0`
- Maintain CHANGELOG.md

### Dependencies Management
- Pin all dependency versions
- Regular security updates
- Use Dependabot for automated updates

### Code Quality
- Type hints throughout
- Docstrings for all functions/classes
- Follow PEP 8 style guide
- Use ruff for linting
- Pre-commit hooks for formatting

---

## Implementation Priority

### Phase 1 (MVP)
1. Project structure and Docker setup
2. Database models and migrations
3. Authentication system
4. Post CRUD operations
5. Media upload and processing
6. Basic light interface
7. Public frontend (list, single post)
8. RSS feed
9. Theming system
10. CI/CD pipeline

### Phase 2 (Enhancement)
1. Tag management UI improvements
2. Gallery view
3. Cache implementation
4. Advanced settings
5. Session management
6. Analytics integration
7. Backup automation
8. Search functionality

### Phase 3 (Polish)
1. Performance optimization
2. Advanced image editing
3. Import/export tools
4. Enhanced light dashboard
5. Monitoring and alerts
6. Additional themes
7. Plugin system (if needed)

---

## Questions & Decisions Needed

1. **Light UI Framework**: Plain HTML/CSS + minimal JS vs lightweight framework (Alpine.js, HTMX)?
2. **Text Formatter**: Markdown library preference (markdown-it, CommonMark)?
3. **Image Library**: Stick with Pillow or add imagemagick for advanced features?
4. **Deployment Target**: DigitalOcean Droplet or Hostinger VPS specifics?
5. **Domain & SSL**: Using Cloudflare, Let's Encrypt, or other?
6. **Backup Destination**: S3-compatible service preference (DigitalOcean Spaces, Backblaze B2, Wasabi)?
7. **Analytics**: Google Analytics, Plausible, or custom solution?
8. **Error Tracking**: Sentry integration or just logs?
