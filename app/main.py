"""FastAPI application entry point.

Configures the application with middleware, routes, and lifecycle events.
"""

from collections.abc import AsyncGenerator, MutableMapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import Receive, Scope, Send

from app.api.auth import router as auth_router
from app.api.feeds import router as feeds_router
from app.api.media import router as media_router
from app.api.pages import router as pages_router
from app.api.posts import router as posts_router
from app.api.settings import router as settings_router
from app.api.system import router as system_router
from app.api.tags import router as tags_router
from app.config import get_settings
from app.database import create_tables, get_db
from app.logging import setup_logging
from app.services.scheduler_service import SchedulerService

# Initialize logging
setup_logging()

settings = get_settings()

# Path to the frontend SPA directory
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
FRONTEND_INDEX = FRONTEND_DIR / "index.html"


class CachedStaticFiles(StaticFiles):
    """Static files handler with cache control headers."""

    def __init__(
        self, *args: Any, max_age: int = 86400, immutable: bool = False, **kwargs: Any
    ):
        """Initialize cached static files.

        Args:
            max_age: Cache max-age in seconds (default 1 day)
            immutable: Whether files are immutable (enables long-term caching)
        """
        super().__init__(*args, **kwargs)
        self.max_age = max_age
        self.immutable = immutable

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Handle request with cache headers."""

        async def send_with_cache_headers(message: MutableMapping[str, Any]) -> None:
            if message["type"] == "http.response.start":
                if self.immutable:
                    cache_value = f"public, max-age={self.max_age}, immutable"
                else:
                    cache_value = f"public, max-age={self.max_age}"

                headers = list(message.get("headers", []))
                headers.append((b"cache-control", cache_value.encode()))
                await send({**message, "headers": headers})
            else:
                await send(message)

        await super().__call__(scope, receive, send_with_cache_headers)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses."""

    async def dispatch(self, request: Request, call_next: Any) -> Any:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        if settings.force_https and settings.app_env == "production":
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://www.googletagmanager.com https://www.google-analytics.com; "
            "media-src 'self' blob:; "
            "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; "
            "style-src 'self' 'unsafe-inline'; "
            "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com"
        )
        return response


def ensure_media_directories() -> None:
    """Ensure media storage directories exist."""
    storage_path = Path(settings.storage_path)
    directories = [
        storage_path / "media" / "originals",
        storage_path / "media" / "thumbnails",
    ]
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan events.

    Handles startup and shutdown tasks.
    """
    # Startup
    await create_tables()

    from app.migrations.runner import run_migrations
    await run_migrations()

    ensure_media_directories()

    scheduler = SchedulerService()
    scheduler.start()

    yield

    # Shutdown
    scheduler.shutdown()


app = FastAPI(
    title="Photo Blog API",
    description="""
## Photo Blog Engine API

A pure JSON REST API for the Photo Blog Engine. All write operations require
an authenticated session (HTTP-only cookie from `POST /api/auth/login`).
Read endpoints for published content are public and require no authentication.

### Authentication

1. `POST /api/auth/login` with username + password
2. The server sets an HTTP-only `session_token` cookie
3. All subsequent requests automatically include the cookie

### Conventions

- Dates are ISO 8601 strings in UTC
- Pagination: `page` (1-indexed) and `per_page` query parameters
- Errors: `{"detail": "human-readable message"}` format
- File uploads use `multipart/form-data`
""",
    version="2.0.0",
    contact={"name": "Photo Blog Engine"},
    license_info={"name": "MIT"},
    openapi_tags=[
        {"name": "Authentication", "description": "Login, logout, session management"},
        {"name": "Posts", "description": "Blog post CRUD and publishing workflow"},
        {"name": "Media", "description": "File upload and media management"},
        {"name": "Tags", "description": "Tag CRUD and hierarchy management"},
        {"name": "Settings", "description": "Blog configuration settings"},
        {"name": "System", "description": "System stats, logs, cache, backups"},
        {"name": "Pages", "description": "Compound page data endpoints for the SPA frontend"},
        {"name": "Public", "description": "Public read-only endpoints — no auth required"},
    ],
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# CORS — config-driven, supports dev cross-origin and production same-origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security headers middleware
app.add_middleware(SecurityHeadersMiddleware)

# ── API routers ───────────────────────────────────────────────────────────────
app.include_router(auth_router)
app.include_router(feeds_router)
app.include_router(posts_router)
app.include_router(media_router)
app.include_router(tags_router)
app.include_router(settings_router)
app.include_router(system_router)
app.include_router(pages_router)

# ── Media file serving ────────────────────────────────────────────────────────
media_path = Path(settings.storage_path) / "media"
media_path.mkdir(parents=True, exist_ok=True)
app.mount(
    "/media",
    StaticFiles(directory=str(media_path.resolve())),
    name="media",
)

# ── Frontend static files ─────────────────────────────────────────────────────
# Only mount if the frontend directory exists (may be absent during early dev)
_frontend_css = FRONTEND_DIR / "css"
_frontend_src = FRONTEND_DIR / "src"
_frontend_images = FRONTEND_DIR / "images"

if _frontend_css.is_dir():
    app.mount(
        "/assets/css",
        CachedStaticFiles(directory=str(_frontend_css.resolve()), max_age=3600),
        name="frontend-css",
    )

if _frontend_src.is_dir():
    app.mount(
        "/assets/js",
        StaticFiles(directory=str(_frontend_src.resolve())),
        name="frontend-js",
    )

if _frontend_images.is_dir():
    app.mount(
        "/assets/images",
        CachedStaticFiles(directory=str(_frontend_images.resolve()), max_age=86400),
        name="frontend-images",
    )

# Vendor libs (Leaflet, etc.) if present
_frontend_vendor = FRONTEND_DIR / "vendor"
if _frontend_vendor.is_dir():
    app.mount(
        "/assets/vendor",
        CachedStaticFiles(directory=str(_frontend_vendor.resolve()), max_age=86400, immutable=True),
        name="frontend-vendor",
    )


# ── Exception handlers ────────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Handle uncaught exceptions."""
    if settings.debug:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": str(exc), "type": type(exc).__name__},
        )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


# ── Standalone API routes ─────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
async def health_check(
    db: Any = Depends(get_db),
) -> dict[str, str]:
    """Health check endpoint.

    Verifies the application is running and the database is accessible.
    """
    from sqlalchemy import text

    await db.execute(text("SELECT 1"))
    return {"status": "healthy"}


@app.get("/{year:int}/{month:int}/{filename}", tags=["Public"])
async def serve_simplified_media(year: int, month: int, filename: str) -> FileResponse:
    """Serve media files using the simplified path /YYYY/MM/filename."""
    file_path = (
        Path(settings.storage_path) / "media" / "originals" / str(year) / f"{month:02d}" / filename
    )
    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media not found",
        )
    return FileResponse(file_path)


@app.get("/preview/{token}", tags=["Public"])
async def preview_post(
    token: str,
    db: Any = Depends(get_db),
) -> dict[str, Any]:
    """Preview a draft post using a shareable preview token.

    Allows viewing draft posts without authentication when the viewer
    holds a valid, non-expired preview token.
    """
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.models.post import Post
    from app.utils.formatters import format_content

    result = await db.execute(select(Post).where(Post.preview_token == token))
    post = result.scalar_one_or_none()

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid preview token",
        )

    if post.preview_expires_at:
        expires_at = post.preview_expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if expires_at < datetime.now(UTC):
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="Preview link has expired",
            )

    return {
        "id": post.id,
        "title": post.title,
        "slug": post.slug,
        "content": post.content,
        "content_html": format_content(post.content, post.formatter.value),
        "excerpt": post.excerpt,
        "formatter": post.formatter.value,
        "status": post.status.value,
        "is_featured": post.is_featured,
        "published_at": post.published_at,
        "created_at": post.created_at,
        "updated_at": post.updated_at,
        "thumbnail_path": post.thumbnail_path,
        "meta_description": post.meta_description,
        "preview_mode": True,
    }


# ── SPA fallback — MUST be the last route registered ─────────────────────────
@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str) -> FileResponse:
    """Serve the SPA shell (index.html) for all non-API, non-media routes.

    This enables client-side routing: the browser loads the SPA once and
    the JavaScript router handles all subsequent navigation.
    """
    if FRONTEND_INDEX.is_file():
        return FileResponse(FRONTEND_INDEX)
    # Graceful degradation while the frontend has not been built yet
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Frontend not available — build the frontend first (see frontend/README.md)",
    )
