"""FastAPI application entry point.

Configures the application with middleware, routes, and lifecycle events.
"""

from collections.abc import AsyncGenerator, MutableMapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import Receive, Scope, Send

from app.api.auth import router as auth_router
from app.api.light import router as light_router
from app.api.media import router as media_router
from app.api.posts import router as posts_router
from app.api.public import router as public_router
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

        # Create a custom send that adds cache headers
        async def send_with_cache_headers(message: MutableMapping[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))

                # Add cache control header
                if self.immutable:
                    cache_value = f"public, max-age={self.max_age}, immutable"
                else:
                    cache_value = f"public, max-age={self.max_age}"

                headers.append((b"cache-control", cache_value.encode()))
                message["headers"] = headers

            await send(message)

        await super().__call__(scope, receive, send_with_cache_headers)


# Set up Jinja2 templates
templates_dir = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(templates_dir))


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
            "img-src 'self' data:; "
            "media-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'"
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
    ensure_media_directories()

    # Initialize and start scheduler
    scheduler = SchedulerService()
    scheduler.start()

    yield

    # Shutdown
    scheduler.shutdown()


app = FastAPI(
    title=settings.app_name,
    description="A lightweight, personal photo blog engine",
    version="0.1.0",
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.debug else [],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security headers middleware
app.add_middleware(SecurityHeadersMiddleware)

# Include routers
app.include_router(light_router)
app.include_router(auth_router)
app.include_router(media_router)
app.include_router(posts_router)
app.include_router(public_router)
app.include_router(settings_router)
app.include_router(system_router)
app.include_router(tags_router)

# Mount static files for media serving (images cached for 7 days)
media_path = Path(settings.storage_path) / "media"
media_path.mkdir(parents=True, exist_ok=True)
app.mount(
    "/media",
    CachedStaticFiles(directory=str(media_path), max_age=604800),  # 7 days
    name="media",
)

# Mount static files for light assets (CSS, JS) - cached for 1 day
static_path = Path(__file__).parent / "static"
app.mount(
    "/static",
    CachedStaticFiles(directory=str(static_path), max_age=86400),  # 1 day
    name="static",
)


@app.exception_handler(Exception)
async def global_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Handle uncaught exceptions.

    Returns a generic error response to avoid leaking internal details.
    """
    if settings.debug:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": str(exc), "type": type(exc).__name__},
        )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


@app.get("/health", tags=["System"])
async def health_check(
    db: Any = Depends(get_db),
) -> dict[str, str]:
    """Health check endpoint.

    Verifies the application is running and the database is accessible.

    Args:
        db: Database session

    Returns:
        Status indicating the application is running and DB is reachable
    """
    from sqlalchemy import text

    await db.execute(text("SELECT 1"))
    return {"status": "healthy"}


@app.get("/preview/{token}", tags=["Public"])
async def preview_post(
    token: str,
    db: Any = Depends(get_db),
) -> dict[str, Any]:
    """Preview a draft post using a preview token.

    This endpoint allows viewing draft posts without authentication
    if the viewer has a valid preview token.

    Args:
        token: The preview token from the preview link
        db: Database session

    Returns:
        Post data if token is valid

    Raises:
        HTTPException: If token is invalid or expired
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

    # Handle timezone-naive and timezone-aware datetime comparison
    if post.preview_expires_at:
        # Make comparison timezone-aware safe
        expires_at = post.preview_expires_at
        if expires_at.tzinfo is None:
            # If naive, treat as UTC
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
