"""API routes package.

Exports all API routers for the application.
"""

from app.api.auth import router as auth_router
from app.api.posts import router as posts_router

__all__ = ["auth_router", "posts_router"]
