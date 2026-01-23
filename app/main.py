"""FastAPI application entry point.

Configures the application with middleware, routes, and lifecycle events.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware

from app.api.admin import router as admin_router
from app.api.auth import router as auth_router
from app.api.media import router as media_router
from app.api.posts import router as posts_router
from app.api.tags import router as tags_router
from app.config import get_settings
from app.database import create_tables, get_db

settings = get_settings()

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
    yield
    # Shutdown (cleanup if needed)


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
app.include_router(admin_router)
app.include_router(auth_router)
app.include_router(media_router)
app.include_router(posts_router)
app.include_router(tags_router)

# Mount static files for media serving
media_path = Path(settings.storage_path) / "media"
media_path.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(media_path)), name="media")

# Mount static files for admin assets (CSS, JS)
static_path = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_path)), name="static")


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
async def health_check() -> dict[str, str]:
    """Health check endpoint.

    Returns:
        Status indicating the application is running
    """
    return {"status": "healthy"}


@app.get("/", tags=["Public"])
async def root() -> dict[str, str]:
    """Root endpoint.

    Returns:
        Welcome message and API information
    """
    return {
        "name": settings.app_name,
        "version": "0.1.0",
        "status": "running",
    }


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
