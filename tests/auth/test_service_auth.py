"""Tests for AuthService authentication operations.

This module contains unit tests for user authentication.
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
def auth_service(db: AsyncSession):
    """Create AuthService instance with test database."""
    return AuthService(db)


# =============================================================================
# Authentication Tests
# =============================================================================


class TestAuthentication:
    """Test cases for user authentication."""

    @pytest.mark.asyncio
    async def test_authenticate_user_success(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test successful user authentication."""
        user_data = UserCreate(
            username="authuser",
            email="auth@example.com",
            password="correctpassword",
            display_name="Auth User",
        )
        await auth_service.create_user(user_data)

        # Authenticate with correct credentials
        user = await auth_service.authenticate_user("authuser", "correctpassword")

        assert user is not None
        assert user.username == "authuser"

    @pytest.mark.asyncio
    async def test_authenticate_user_wrong_password(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test authentication with invalid password."""
        user_data = UserCreate(
            username="user1",
            email="u@e.com",
            password="password123",
            display_name="U",
        )
        await auth_service.create_user(user_data)

        # Wrong password
        result = await auth_service.authenticate_user("user1", "wrongpassword")
        assert result is None

    @pytest.mark.asyncio
    async def test_authenticate_user_nonexistent(
        self, auth_service: AuthService
    ) -> None:
        """Test authentication with non-existent user."""
        result = await auth_service.authenticate_user("nobody", "password")
        assert result is None
