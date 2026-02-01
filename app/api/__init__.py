"""API routes package.

Exports all API routers for the application.
"""

from app.api.auth import router as auth_router
from app.api.light import router as light_router
from app.api.media import router as media_router
from app.api.posts import router as posts_router
from app.api.public import router as public_router
from app.api.settings import router as settings_router
from app.api.system import router as system_router
from app.api.tags import router as tags_router

__all__ = [
    "light_router",
    "auth_router",
    "media_router",
    "posts_router",
    "public_router",
    "settings_router",
    "system_router",
    "tags_router",
]
