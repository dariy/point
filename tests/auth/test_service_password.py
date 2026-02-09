"""Tests for AuthService password management operations.

This module contains unit tests for password change operations.
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
# Password Management Tests
# =============================================================================


class TestPasswordManagement:
    """Test cases for password change operations."""

    @pytest.mark.asyncio
    async def test_change_password_success(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test successful password change."""
        user_data = UserCreate(
            username="cpuser",
            email="cp@example.com",
            password="oldpassword",
            display_name="CP User",
        )
        user = await auth_service.create_user(user_data)

        # Change password
        result = await auth_service.change_password(
            user.id, "oldpassword", "newpassword123"
        )

        assert result is True

        # Verify new password works
        authenticated = await auth_service.authenticate_user("cpuser", "newpassword123")
        assert authenticated is not None

    @pytest.mark.asyncio
    async def test_change_password_wrong_current(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test password change with wrong current password."""
        user_data = UserCreate(
            username="cpuser2",
            email="cp2@example.com",
            password="oldpassword",
            display_name="CP User 2",
        )
        user = await auth_service.create_user(user_data)

        # Try with wrong current password
        result = await auth_service.change_password(
            user.id, "wrongpassword", "newpassword123"
        )

        assert result is False

    @pytest.mark.asyncio
    async def test_change_password_too_short(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test password change with too short new password."""
        user_data = UserCreate(
            username="cpuser3",
            email="cp3@example.com",
            password="oldpassword",
            display_name="CP User 3",
        )
        user = await auth_service.create_user(user_data)

        # Try with too short new password
        with pytest.raises(ValueError, match="at least 8 characters"):
            await auth_service.change_password(user.id, "oldpassword", "short")

    @pytest.mark.asyncio
    async def test_change_password_user_not_found(
        self, auth_service: AuthService
    ) -> None:
        """Test password change for non-existent user."""
        result = await auth_service.change_password(
            999, "oldpassword", "newpassword123"
        )
        assert result is False
