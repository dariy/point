# API Changes — Backend Migration to Pure JSON API

> **Created**: 2026-02-19
> **Status**: Design Specification
> **Companion**: [REFACTORING.md](./REFACTORING.md)

This document lists every concrete change required to make the FastAPI
backend a pure JSON API with no template-rendering responsibilities.

---

## Table of Contents

1. [Summary of Changes](#summary-of-changes)
2. [app/main.py](#appmainpy)
3. [app/config.py](#appconfigpy)
4. [app/api/auth.py](#appapiauthorpy)
5. [app/api/posts.py](#appapiposts)
6. [app/api/settings.py — new endpoint](#appapisettingspy)
7. [app/api/pages.py — new file](#appapiPagespy)
8. [app/schemas/post.py](#appschemaspostpy)
9. [OpenAPI Documentation](#openapi-documentation)
10. [Routes to Delete](#routes-to-delete)
11. [Dependencies to Remove](#dependencies-to-remove)
12. [Test Changes](#test-changes)

---

## Summary of Changes

| Change | Type | Priority |
|--------|------|----------|
| Add CORS middleware | Modify `main.py` | High |
| Add SPA fallback route | Modify `main.py` | High |
| Remove Jinja2 setup | Modify `main.py` | High |
| Remove `light.py` router | Delete file | High |
| Remove `public.py` router | Delete file | High |
| Remove `template_helpers.py` | Delete file | High |
| Remove `app/templates/` | Delete directory | High |
| Add `CORS_ORIGINS` config | Modify `config.py` | High |
| Auth routes return JSON only | Modify `auth.py` | High |
| Add `PostListItem` schema | Modify `schemas/post.py` | Medium |
| Enrich `PostResponse` schema | Modify `schemas/post.py` | Medium |
| Add `/api/settings/public` | Modify `settings.py` | Medium |
| Add `/api/pages/*` endpoints | New `pages.py` | Medium |
| OpenAPI metadata | Modify `main.py` | Medium |
| Enrich route docs | Modify all api files | Low |
| Update tests | Modify `tests/` | Medium |

---

## app/main.py

### 1. Remove Jinja2 and template setup

```python
# DELETE these lines:
from starlette.templating import Jinja2Templates
templates = Jinja2Templates(directory="app/templates")
```

### 2. Remove template-rendering router registrations

```python
# DELETE:
from app.api import light, public
app.include_router(light.router)
app.include_router(public.router)
```

### 3. Add CORS middleware

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Must be added **before** any route registration.

### 4. Register new pages router

```python
from app.api import pages as pages_router
app.include_router(pages_router.router)
```

### 5. Update OpenAPI metadata

```python
app = FastAPI(
    title="Photo Blog API",
    description="""
## Photo Blog Engine API

A JSON REST API for the Photo Blog Engine.

### Authentication
All write endpoints require a session cookie obtained via `POST /api/auth/login`.
Read endpoints for published content are public.

### Conventions
- Dates are ISO 8601 strings in UTC
- Pagination uses `page` and `page_size` query parameters
- Errors use the `{"detail": "message"}` format
""",
    version="2.0.0",
    contact={
        "name": "Photo Blog Engine",
        "url": "https://github.com/your-repo",
    },
    license_info={
        "name": "MIT",
    },
    openapi_tags=[
        {"name": "auth",     "description": "Authentication and session management"},
        {"name": "posts",    "description": "Blog post CRUD and publishing"},
        {"name": "media",    "description": "Media file upload and management"},
        {"name": "tags",     "description": "Tag management and hierarchy"},
        {"name": "settings", "description": "Blog configuration settings"},
        {"name": "system",   "description": "System stats, logs, backups"},
        {"name": "pages",    "description": "Compound page data for the SPA frontend"},
        {"name": "public",   "description": "Public-facing read-only endpoints (no auth)"},
    ],
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)
```

### 6. Mount frontend static files

```python
import os
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

# Mount frontend assets (JS, CSS, images)
if os.path.isdir(os.path.join(FRONTEND_DIR, "css")):
    app.mount(
        "/assets/css",
        StaticFiles(directory=os.path.join(FRONTEND_DIR, "css")),
        name="frontend-css",
    )

if os.path.isdir(os.path.join(FRONTEND_DIR, "src")):
    app.mount(
        "/assets/js",
        StaticFiles(directory=os.path.join(FRONTEND_DIR, "src")),
        name="frontend-js",
    )
```

### 7. Add SPA fallback route (must be LAST)

```python
# SPA fallback — serve index.html for all non-API, non-media routes
# This MUST be the last route registered.
INDEX_HTML = os.path.join(FRONTEND_DIR, "index.html")

@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    """Serve the SPA shell for all non-API routes."""
    if os.path.isfile(INDEX_HTML):
        return FileResponse(INDEX_HTML)
    # Graceful fallback during development before frontend is built
    from fastapi.responses import HTMLResponse
    return HTMLResponse("<h1>Frontend not built yet</h1>", status_code=503)
```

**Important ordering in main.py:**

```
1. App creation + metadata
2. Middleware (CORS, etc.)
3. app.mount() for media files
4. app.include_router() for all /api/* routers
5. app.mount() for frontend static files
6. SPA fallback @app.get("/{full_path:path}")  <- MUST BE LAST
```

---

## app/config.py

### Add CORS_ORIGINS setting

```python
class Settings(BaseSettings):
    # ... existing fields ...

    # CORS
    cors_origins: list[str] = Field(
        default=["http://localhost:3000", "http://localhost:8000"],
        description="Allowed CORS origins. Use ['*'] behind a trusted reverse proxy.",
    )
```

Environment variable: `CORS_ORIGINS='["https://myblog.com"]'`

---

## app/api/auth.py

### Remove all redirect responses

Current behavior: some endpoints return `RedirectResponse`. This must
be changed to always return JSON.

```python
# BEFORE (example):
@router.post("/login")
async def login(data: LoginRequest, response: Response):
    # ...
    return RedirectResponse(url="/light/", status_code=302)

# AFTER:
@router.post("/login", response_model=LoginResponse, tags=["auth"])
async def login(data: LoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    """
    Authenticate user and create a session.

    Sets an HTTP-only session cookie on success.
    The frontend is responsible for navigating after a successful login.
    """
    # ... authentication logic ...
    return LoginResponse(user=user_data, message="Login successful")
```

### Add/update schemas for auth responses

```python
# app/schemas/auth.py additions:

class LoginResponse(BaseModel):
    message: str = "Login successful"
    user: UserResponse

class LogoutResponse(BaseModel):
    message: str = "Logged out successfully"

class UserResponse(BaseModel):
    id: int
    username: str
    display_name: str | None
    avatar_url: str | None

    model_config = ConfigDict(from_attributes=True)
```

### Ensure /api/auth/me returns 401 JSON (not redirect)

```python
@router.get("/me", response_model=UserResponse, tags=["auth"])
async def get_me(current_user = Depends(require_auth)):
    """Get the currently authenticated user."""
    return UserResponse.model_validate(current_user)
```

The `require_auth` dependency must raise `HTTPException(status_code=401)`
(not a redirect) when no valid session exists.

---

## app/api/posts.py

### Ensure PostResponse includes all fields needed by frontend

See schema changes in [app/schemas/post.py](#appschemaspostpy) below.

### Add `PostListItem` as response model for list endpoints

```python
@router.get(
    "/",
    response_model=PaginatedResponse[PostListItem],
    tags=["posts"],
    summary="List posts",
    description="List posts with pagination. Filters: status, featured, tag_id.",
    responses={
        401: {"description": "Not authenticated (for non-public requests)"},
    },
)
async def list_posts(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = None,
    featured: bool | None = None,
    # ...
):
```

### Remove AJAX header check pattern

Current pattern: routes check `request.headers.get("X-Requested-With")`
to decide between JSON and HTML. This check is no longer needed — all
responses are JSON.

```python
# DELETE these patterns throughout posts.py:
if request.headers.get("X-Requested-With") == "XMLHttpRequest":
    return JSONResponse(content={...})
else:
    return templates.TemplateResponse("public/post.html", {...})

# REPLACE with simply:
return post_response
```

---

## app/api/settings.py — new endpoint

### Add GET /api/settings/public

This endpoint returns non-sensitive blog settings needed by the public
frontend without requiring authentication.

```python
PUBLIC_SETTING_KEYS = {
    "blog_title",
    "blog_description",
    "blog_author",
    "blog_author_bio",
    "posts_per_page",
    "show_tag_cloud",
    "footer_text",
    "enable_map",
}

@router.get(
    "/public",
    response_model=dict[str, str],
    tags=["settings", "public"],
    summary="Get public blog settings",
    description="Returns non-sensitive blog settings needed by the public frontend. No authentication required.",
)
async def get_public_settings(
    db: AsyncSession = Depends(get_db),
):
    """Get public-facing blog settings."""
    service = SettingsService(db)
    all_settings = await service.get_all()
    return {k: v for k, v in all_settings.items() if k in PUBLIC_SETTING_KEYS}
```

---

## app/api/pages.py — new file

This new router provides **compound endpoints** — single requests that
return all data needed to render a full page. This reduces round-trips
and makes page transitions faster.

```python
"""
Compound page data endpoints for the SPA frontend.

Each endpoint returns all data needed to render a complete page view,
reducing the number of round-trips the frontend must make on navigation.
"""

# Standard library
from typing import Any

# Third-party
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

# Local
from app.database import get_db
from app.services.post_service import PostService
from app.services.tag_service import TagService
from app.services.settings_service import SettingsService

router = APIRouter(prefix="/api/pages", tags=["pages", "public"])


@router.get(
    "/home",
    response_model=HomePageResponse,
    summary="Homepage data",
    description="Returns published posts (paginated) and tag cloud for the homepage.",
)
async def get_home_page(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
) -> HomePageResponse:
    post_service = PostService(db)
    tag_service = TagService(db)
    settings_service = SettingsService(db)

    posts, total = await post_service.list_published(page=page, page_size=page_size)
    tag_cloud = await tag_service.get_tag_cloud()
    settings = await settings_service.get_public()

    return HomePageResponse(
        posts=[PostListItem.model_validate(p) for p in posts],
        pagination=PaginationMeta(page=page, page_size=page_size, total=total),
        tag_cloud=tag_cloud,
        settings=settings,
    )


@router.get(
    "/tag/{slug}",
    response_model=TagPageResponse,
    summary="Tag page data",
    description="Returns tag info, its post hierarchy breadcrumb, and paginated posts.",
)
async def get_tag_page(
    slug: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
) -> TagPageResponse:
    tag_service = TagService(db)
    post_service = PostService(db)

    tag = await tag_service.get_by_slug(slug)
    breadcrumbs = await tag_service.get_breadcrumbs(tag.id)
    posts, total = await post_service.list_by_tag(tag.id, page=page, page_size=page_size)

    return TagPageResponse(
        tag=TagResponse.model_validate(tag),
        breadcrumbs=[TagResponse.model_validate(t) for t in breadcrumbs],
        posts=[PostListItem.model_validate(p) for p in posts],
        pagination=PaginationMeta(page=page, page_size=page_size, total=total),
    )


@router.get(
    "/tags",
    response_model=TagsPageResponse,
    summary="Tags directory data",
    description="Returns all tags as a hierarchical tree with post counts.",
)
async def get_tags_page(
    db: AsyncSession = Depends(get_db),
) -> TagsPageResponse:
    tag_service = TagService(db)
    tags_tree = await tag_service.get_tree()
    return TagsPageResponse(tags=tags_tree)
```

### Schemas for page endpoints

```python
# app/schemas/pages.py  (new file)

from pydantic import BaseModel
from typing import Generic, TypeVar

T = TypeVar("T")


class PaginationMeta(BaseModel):
    page: int
    page_size: int
    total: int
    total_pages: int

    @classmethod
    def from_total(cls, page: int, page_size: int, total: int) -> "PaginationMeta":
        return cls(
            page=page,
            page_size=page_size,
            total=total,
            total_pages=max(1, (total + page_size - 1) // page_size),
        )


class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    pagination: PaginationMeta


class HomePageResponse(BaseModel):
    posts: list[PostListItem]
    pagination: PaginationMeta
    tag_cloud: list[TagCloudItem]
    settings: dict[str, str]


class TagPageResponse(BaseModel):
    tag: TagResponse
    breadcrumbs: list[TagResponse]
    posts: list[PostListItem]
    pagination: PaginationMeta


class TagsPageResponse(BaseModel):
    tags: list[TagTreeItem]   # hierarchical, includes children recursively
```

---

## app/schemas/post.py

### Add PostListItem (lighter weight for list views)

```python
class PostListItem(BaseModel):
    """Lightweight post representation for list and grid views."""
    id: int
    title: str
    slug: str
    excerpt: str | None
    status: str
    thumbnail_url: str | None    # relative URL, e.g. /2026/01/photo.jpg
    published_at: datetime | None
    created_at: datetime
    is_featured: bool
    view_count: int
    tags: list[TagBasic]         # TagBasic: {id, name, slug}
    author_display_name: str | None

    model_config = ConfigDict(from_attributes=True)
```

### Enrich PostResponse (full post for single post view)

```python
class PostResponse(BaseModel):
    """Full post representation for single post view."""
    id: int
    title: str
    slug: str
    content: str                 # raw content (for editor)
    content_html: str            # formatted HTML (for display)
    formatter: str               # 'markdown' | 'html' | 'plaintext'
    excerpt: str | None
    meta_description: str | None
    status: str
    thumbnail_url: str | None    # full relative URL
    is_featured: bool
    is_immersive: bool           # hint for full-screen media display
    view_count: int
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    tags: list[TagBasic]
    author: AuthorInfo           # {display_name, avatar_url}
    media: list[MediaBasic]      # list of media attached to post
    preview_token: str | None    # only present for current user's own posts

    model_config = ConfigDict(from_attributes=True)


class AuthorInfo(BaseModel):
    display_name: str | None
    avatar_url: str | None


class MediaBasic(BaseModel):
    id: int
    url: str                     # full relative URL
    thumbnail_url: str | None
    file_type: str               # 'image' | 'video' | 'audio'
    alt_text: str | None
    caption: str | None
    width: int | None
    height: int | None
```

### Ensure content_html is always populated

In `PostService`, always call `format_content()` before returning a post:

```python
async def get_post_response(self, post: Post) -> PostResponse:
    content_html = format_content(post.content, post.formatter)
    thumbnail_url = determine_thumbnail_url(post)
    # ...
    return PostResponse(
        **post.__dict__,
        content_html=content_html,
        thumbnail_url=thumbnail_url,
        # ...
    )
```

---

## OpenAPI Documentation

### Per-route documentation standard

Every route must include:

```python
@router.get(
    "/{id}",
    response_model=PostResponse,
    summary="Get post by ID",          # Short one-line description
    description="""
Get a single post by its numeric ID.

Returns the full post data including formatted HTML content,
author info, tags, and attached media.

Requires authentication. For public post access, use `/posts/slug/{slug}`.
""",
    tags=["posts"],
    responses={
        200: {"description": "Post found and returned"},
        401: {"description": "Not authenticated"},
        404: {"description": "Post not found"},
    },
)
```

### Pydantic schema examples

Add `model_config` with `json_schema_extra` to all schemas:

```python
class PostCreate(BaseModel):
    title: str
    content: str
    formatter: str = "markdown"
    status: str = "draft"
    tags: list[str] = []

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "title": "Mountain Sunrise",
                "content": "# Mountain Sunrise\n\nToday I hiked...",
                "formatter": "markdown",
                "status": "draft",
                "tags": ["landscape", "travel"],
            }
        }
    )
```

---

## Routes to Delete

### app/api/light.py — DELETE ENTIRE FILE

Currently renders all admin panel pages as Jinja2 HTML. Replaced entirely
by the frontend SPA.

Routes being deleted:
- `GET /light/login`
- `GET /light/`
- `GET /light/posts`
- `GET /light/posts/new`
- `GET /light/posts/{id}`
- `GET /light/tags`
- `GET /light/media`
- `GET /light/settings`
- `GET /light/security`
- `GET /light/system`

### app/api/public.py — DELETE ENTIRE FILE

Currently renders all public blog pages as Jinja2 HTML. Replaced entirely
by the frontend SPA.

Routes being deleted:
- `GET /` (homepage)
- `GET /posts/{slug}` (single post)
- `GET /tag/{slug}` (tag archive)
- `GET /tags` (tags gallery)
- `GET /map` (geographic map)

**Routes NOT deleted** (remain as backend routes):
- `GET /feed.xml` — RSS feed (raw XML, not an HTML page)
- `GET /sitemap.xml` — Sitemap (raw XML)
- `GET /robots.txt` — Robots file
- `GET /preview/{token}` — Draft preview (can remain as backend redirect to SPA URL)

These will be moved to a small `app/api/feeds.py` router.

### app/utils/template_helpers.py — DELETE

Contains Jinja2 template filter functions. All helper logic either moves
to the frontend (`frontend/src/utils/formatters.js`) or is already
handled in service layer.

### app/templates/ — DELETE ENTIRE DIRECTORY

All 27 Jinja2 templates. None are used after the migration.

---

## Dependencies to Remove

### pyproject.toml

```toml
# REMOVE from dependencies:
"jinja2>=3.1.0",

# KEEP (still used for file upload handling):
"python-multipart>=0.0.6",

# KEEP (all other dependencies remain):
# fastapi, uvicorn, sqlalchemy, aiosqlite, pillow, etc.
```

### app/main.py imports

```python
# DELETE:
from starlette.templating import Jinja2Templates
from fastapi.templating import Jinja2Templates  # (whichever is used)
```

---

## Test Changes

### Tests to delete

Remove all tests that test HTML routes (light.py, public.py):

```
tests/test_api/test_light.py   <- DELETE (if exists)
tests/test_api/test_public.py  <- DELETE (if exists)
```

### Tests to add

```
tests/test_api/test_pages.py   <- New compound endpoints
```

```python
# tests/test_api/test_pages.py

class TestPagesAPI:
    async def test_get_home_page_returns_posts_and_tag_cloud(self, client, published_post):
        response = await client.get("/api/pages/home")
        assert response.status_code == 200
        data = response.json()
        assert "posts" in data
        assert "pagination" in data
        assert "tag_cloud" in data
        assert "settings" in data

    async def test_get_home_page_excludes_drafts(self, client, draft_post):
        response = await client.get("/api/pages/home")
        data = response.json()
        post_ids = [p["id"] for p in data["posts"]]
        assert draft_post.id not in post_ids

    async def test_get_tag_page_returns_tag_and_posts(self, client, tag_with_posts):
        response = await client.get(f"/api/pages/tag/{tag_with_posts.slug}")
        assert response.status_code == 200
        data = response.json()
        assert data["tag"]["slug"] == tag_with_posts.slug
        assert "breadcrumbs" in data
        assert "posts" in data

    async def test_get_tag_page_with_unknown_slug_returns_404(self, client):
        response = await client.get("/api/pages/tag/nonexistent-tag")
        assert response.status_code == 404

    async def test_get_tags_page_returns_tree(self, client, tag_with_children):
        response = await client.get("/api/pages/tags")
        assert response.status_code == 200
        data = response.json()
        assert "tags" in data
```

### Tests to update

```python
# tests/test_api/test_auth.py
# Ensure login returns JSON, not redirect:
async def test_login_success_returns_json(self, client):
    response = await client.post("/api/auth/login", json={...})
    assert response.status_code == 200
    data = response.json()
    assert "user" in data
    assert "message" in data
    # Ensure it is NOT a redirect
    assert response.headers.get("location") is None

# tests/test_api/test_settings.py
# Test new public endpoint:
async def test_get_public_settings_requires_no_auth(self, client):
    response = await client.get("/api/settings/public")
    assert response.status_code == 200
    data = response.json()
    assert "blog_title" in data
    # Sensitive keys not exposed
    assert "admin_password" not in data
```

### SPA fallback test

```python
# tests/test_api/test_main.py
async def test_spa_fallback_returns_index_html(self, client):
    """Non-API routes should serve the SPA shell."""
    response = await client.get("/light/dashboard")
    assert response.status_code == 200
    # Should return HTML, not JSON
    assert "text/html" in response.headers["content-type"]

async def test_api_routes_not_intercepted_by_spa_fallback(self, client):
    """API routes must not fall through to SPA fallback."""
    response = await client.get("/api/posts")
    assert response.headers["content-type"].startswith("application/json")
```

---

## Migration Checklist

### Backend changes

- [ ] `app/main.py`: Remove Jinja2 setup
- [ ] `app/main.py`: Add CORS middleware
- [ ] `app/main.py`: Update OpenAPI metadata
- [ ] `app/main.py`: Mount frontend static files
- [ ] `app/main.py`: Add SPA fallback route (last)
- [ ] `app/main.py`: Register new pages router
- [ ] `app/config.py`: Add `cors_origins` field
- [ ] `app/api/auth.py`: Remove all `RedirectResponse` returns
- [ ] `app/api/auth.py`: Add `LoginResponse`, `LogoutResponse` schemas
- [ ] `app/api/posts.py`: Remove AJAX header check pattern
- [ ] `app/api/posts.py`: Use `PostListItem` for list responses
- [ ] `app/api/settings.py`: Add `GET /api/settings/public`
- [ ] `app/api/pages.py`: Create with home, tag, tags endpoints
- [ ] `app/schemas/post.py`: Add `PostListItem`, `AuthorInfo`, `MediaBasic`
- [ ] `app/schemas/post.py`: Enrich `PostResponse` with all frontend-needed fields
- [ ] `app/schemas/pages.py`: Create with page response schemas
- [ ] `app/api/light.py`: **DELETE**
- [ ] `app/api/public.py`: **DELETE**
- [ ] `app/utils/template_helpers.py`: **DELETE**
- [ ] `app/templates/`: **DELETE directory**
- [ ] `pyproject.toml`: Remove `jinja2` dependency

### Test changes

- [ ] `tests/test_api/test_light.py`: Delete (if exists)
- [ ] `tests/test_api/test_public.py`: Delete (if exists)
- [ ] `tests/test_api/test_pages.py`: Create
- [ ] `tests/test_api/test_auth.py`: Update login test assertions
- [ ] `tests/test_api/test_settings.py`: Add public endpoint test
- [ ] `tests/test_api/test_main.py`: Add SPA fallback test
- [ ] All existing tests: verify still passing

### Verification

After applying all changes, verify:

```bash
# Backend starts without errors
uvicorn app.main:app --reload

# OpenAPI spec is valid
curl http://localhost:8000/api/openapi.json | python3 -m json.tool

# Swagger UI loads
open http://localhost:8000/api/docs

# SPA fallback works
curl http://localhost:8000/light/dashboard  # should return HTML

# API routes still work
curl http://localhost:8000/api/posts        # should return JSON

# CORS headers present
curl -H "Origin: http://localhost:3000" http://localhost:8000/api/posts -v 2>&1 | grep -i "access-control"
```
