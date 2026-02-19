"""API routes package.

Exports all API routers for the application.
"""

from app.api.auth import router as auth_router
from app.api.feeds import router as feeds_router
from app.api.media import router as media_router
from app.api.pages import router as pages_router
from app.api.posts import router as posts_router
from app.api.settings import router as settings_router
from app.api.system import router as system_router
from app.api.tags import router as tags_router

__all__ = [
    "auth_router",
    "feeds_router",
    "media_router",
    "pages_router",
    "posts_router",
    "settings_router",
    "system_router",
    "tags_router",
]
