"""Tests for AuthService user management operations.

This module contains unit tests for user creation and retrieval.
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
# User Management Tests
# =============================================================================


class TestUserManagement:
    """Test cases for user creation and retrieval."""

    @pytest.mark.asyncio
    async def test_create_user_success(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test successful user creation."""
        user_data = UserCreate(
            username="newuser",
            email="new@example.com",
            password="password123",
            display_name="New User",
        )
        user = await auth_service.create_user(user_data)

        assert user.username == "newuser"
        assert user.email == "new@example.com"
        assert user.display_name == "New User"
        assert user.password_hash != "password123"  # Should be hashed

    @pytest.mark.asyncio
    async def test_create_user_duplicate_username(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test creating user with duplicate username raises ValueError."""
        user_data = UserCreate(
            username="duplicate",
            email="d@e.com",
            password="password123",
            display_name="Display",
        )
        await auth_service.create_user(user_data)

        # Try to create again with same username
        with pytest.raises(ValueError, match="already exists"):
            await auth_service.create_user(user_data)

    @pytest.mark.asyncio
    async def test_get_first_user(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test getting first user from database."""
        # Create a user
        user_data = UserCreate(
            username="firstuser",
            email="first@example.com",
            password="password123",
            display_name="First User",
        )
        created_user = await auth_service.create_user(user_data)

        # Get first user
        first_user = await auth_service.get_first_user()

        assert first_user is not None
        assert first_user.id == created_user.id

    @pytest.mark.asyncio
    async def test_get_first_user_empty_db(
        self, auth_service: AuthService
    ) -> None:
        """Test getting first user when database is empty."""
        first_user = await auth_service.get_first_user()
        assert first_user is None
