"""Authentication schemas for request/response validation.

Defines Pydantic models for login, user info, and session management.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    """Schema for login request."""

    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1)
    remember_me: bool = Field(default=False, description="Extended session expiry")


class LoginResponse(BaseModel):
    """Schema for login response."""

    message: str = "Login successful"
    user: "UserResponse"


class UserResponse(BaseModel):
    """Schema for user information response."""

    id: int
    username: str
    email: str
    display_name: str
    avatar_path: str | None = None
    created_at: datetime
    last_login: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class UserCreate(BaseModel):
    """Schema for creating a new user."""

    username: str = Field(..., min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_]+$")
    email: str = Field(..., max_length=200)
    password: str = Field(..., min_length=8)
    display_name: str = Field(..., min_length=1, max_length=100)


class PasswordChangeRequest(BaseModel):
    """Schema for password change request."""

    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class SessionResponse(BaseModel):
    """Schema for session information response."""

    id: int
    ip_address: str
    user_agent: str
    location: str | None = None
    created_at: datetime
    expires_at: datetime
    last_activity: datetime
    is_current: bool = False

    model_config = ConfigDict(from_attributes=True)


class SessionListResponse(BaseModel):
    """Schema for list of sessions response."""

    sessions: list[SessionResponse]
    total: int


class MessageResponse(BaseModel):
    """Schema for simple message response."""

    message: str
