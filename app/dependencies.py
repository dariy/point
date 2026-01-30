"""FastAPI dependencies for authentication and authorization.

Provides dependency injection functions for protected routes.
"""

from fastapi import Cookie, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.session import Session
from app.models.user import User
from app.services.auth_service import AuthService

# Cookie name for session token
SESSION_COOKIE_NAME = "session_token"


async def get_session_token(
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> str | None:
    """Extract session token from cookie.

    Args:
        session_token: Session token from cookie

    Returns:
        Session token or None
    """
    return session_token


async def get_current_session(
    token: str | None = Depends(get_session_token),
    db: AsyncSession = Depends(get_db),
) -> Session | None:
    """Get current session if valid.

    Args:
        token: Session token
        db: Database session

    Returns:
        Session if valid, None otherwise
    """
    if not token:
        return None

    auth_service = AuthService(db)
    return await auth_service.validate_session(token)


async def get_current_user(
    session: Session | None = Depends(get_current_session),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """Get current user if authenticated.

    Args:
        session: Current session
        db: Database session

    Returns:
        User if authenticated, None otherwise
    """
    if not session:
        return None

    auth_service = AuthService(db)
    return await auth_service.get_user_by_id(session.user_id)


async def require_auth(
    user: User | None = Depends(get_current_user),
) -> User:
    """Require authentication for route.

    Args:
        user: Current user

    Returns:
        Authenticated user

    Raises:
        HTTPException: If not authenticated
    """
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Cookie"},
        )
    return user


def get_client_ip(request: Request) -> str:
    """Get client IP address from request.

    Handles X-Forwarded-For header for proxied requests.

    Args:
        request: FastAPI request

    Returns:
        Client IP address
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        # Take the first IP in the chain (original client)
        return forwarded.split(",")[0].strip()

    if request.client:
        return request.client.host

    return "unknown"


def get_user_agent(request: Request) -> str:
    """Get user agent from request.

    Args:
        request: FastAPI request

    Returns:
        User agent string
    """
    return request.headers.get("User-Agent", "unknown")
