"""Authentication API endpoints.

Handles login, logout, session management, and password changes.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.dependencies import (
    SESSION_COOKIE_NAME,
    get_client_ip,
    get_current_session,
    get_user_agent,
    require_auth,
)
from app.models.session import Session
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    MessageResponse,
    PasswordChangeRequest,
    SessionListResponse,
    SessionResponse,
    UserResponse,
)
from app.services.auth_service import AuthService

settings = get_settings()

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


@router.post(
    "/login",
    response_model=LoginResponse,
    summary="Login with username and password",
)
async def login(
    request: Request,
    response: Response,
    login_data: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> LoginResponse:
    """Authenticate user and create session.

    Returns session cookie on successful authentication.
    """
    auth_service = AuthService(db)

    # Determine user to authenticate
    if login_data.username:
        user = await auth_service.authenticate_user(
            login_data.username, login_data.name
        )
    else:
        # For single-user blog, fetch the first user
        target_user = await auth_service.get_first_user()
        if not target_user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="No user found in system",
            )

        user = await auth_service.authenticate_user(
            target_user.username, login_data.name
        )

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password" if login_data.username else "Invalid password",
        )

    # Create session
    session, plain_token = await auth_service.create_session(
        user_id=user.id,
        ip_address=get_client_ip(request),
        user_agent=get_user_agent(request),
        remember_me=login_data.remember_me,
    )

    # Set session cookie
    max_age = (
        settings.session_expiry_hours * 3600
        if login_data.remember_me
        else None  # Session cookie
    )

    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=plain_token,
        max_age=max_age,
        httponly=True,
        secure=settings.force_https and settings.app_env == "production",
        samesite="lax",
    )

    return LoginResponse(
        message="Login successful",
        user=UserResponse.model_validate(user),
    )


@router.post(
    "/logout",
    response_model=MessageResponse,
    summary="Logout and terminate session",
)
async def logout(
    response: Response,
    session: Session | None = Depends(get_current_session),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Terminate current session and clear cookie."""
    if session:
        auth_service = AuthService(db)
        await auth_service.terminate_session(session.id, session.user_id)

    # Clear cookie
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        httponly=True,
        secure=settings.force_https and settings.app_env == "production",
        samesite="lax",
    )

    return MessageResponse(message="Logged out successfully")


@router.get(
    "/me",
    response_model=UserResponse,
    summary="Get current user information",
)
async def get_me(
    current_user: User = Depends(require_auth),
) -> UserResponse:
    """Get information about the currently authenticated user."""
    return UserResponse.model_validate(current_user)


@router.post(
    "/change-password",
    response_model=MessageResponse,
    summary="Change password",
)
async def change_password(
    password_data: PasswordChangeRequest,
    current_user: User = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Change the current user's password.

    Requires the current password for verification.
    """
    auth_service = AuthService(db)

    try:
        success = await auth_service.change_password(
            user_id=current_user.id,
            current_password=password_data.current_name,
            new_password=password_data.new_name,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    return MessageResponse(message="Password changed successfully")


@router.get(
    "/sessions",
    response_model=SessionListResponse,
    summary="List all active sessions",
)
async def list_sessions(
    current_user: User = Depends(require_auth),
    current_session: Session | None = Depends(get_current_session),
    db: AsyncSession = Depends(get_db),
) -> SessionListResponse:
    """Get all active sessions for the current user."""
    auth_service = AuthService(db)
    sessions = await auth_service.get_user_sessions(current_user.id)

    session_responses = []
    for s in sessions:
        session_response = SessionResponse.model_validate(s)
        session_response.is_current = (
            current_session is not None and s.id == current_session.id
        )
        session_responses.append(session_response)

    return SessionListResponse(
        sessions=session_responses,
        total=len(session_responses),
    )


@router.delete(
    "/sessions/{session_id}",
    response_model=MessageResponse,
    summary="Terminate a specific session",
)
async def terminate_session(
    session_id: int,
    current_user: User = Depends(require_auth),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Terminate a specific session by ID."""
    auth_service = AuthService(db)
    success = await auth_service.terminate_session(session_id, current_user.id)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )

    return MessageResponse(message="Session terminated")


@router.delete(
    "/sessions",
    response_model=MessageResponse,
    summary="Terminate all other sessions",
)
async def terminate_all_sessions(
    current_user: User = Depends(require_auth),
    current_session: Session | None = Depends(get_current_session),
    db: AsyncSession = Depends(get_db),
) -> MessageResponse:
    """Terminate all sessions except the current one."""
    auth_service = AuthService(db)
    count = await auth_service.terminate_all_sessions(
        user_id=current_user.id,
        except_session_id=current_session.id if current_session else None,
    )

    return MessageResponse(message=f"Terminated {count} session(s)")
