"""API routes package.

Exports all API routers for the application.
"""

from app.api.auth import router as auth_router
from app.api.media import router as media_router
from app.api.posts import router as posts_router
from app.api.tags import router as tags_router

__all__ = ["auth_router", "media_router", "posts_router", "tags_router"]
