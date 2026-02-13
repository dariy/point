"""Tests for user account and profile management."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


class TestUserManagementAPI:
    """Test cases for user-related API endpoints."""

    @pytest.mark.asyncio
    async def test_get_me_authenticated(self, client: AsyncClient, auth_cookies: dict, test_user: dict) -> None:
        """Test retrieving current user information when logged in."""
        response = await client.get("/api/auth/me", cookies=auth_cookies)
        assert response.status_code == 200
        assert response.json()["username"] == test_user["username"]

    @pytest.mark.asyncio
    async def test_get_me_unauthenticated(self, client: AsyncClient) -> None:
        """Test that /me returns 401 when not logged in."""
        response = await client.get("/api/auth/me")
        assert response.status_code == 401


class TestAuthServiceUser:
    """Unit tests for AuthService user operations."""

    @pytest.mark.asyncio
    async def test_create_user_duplicate(self, db: AsyncSession, test_user: dict) -> None:
        """Test that creating a user with an existing username fails."""
        auth_service = AuthService(db)
        user_data = UserCreate(
            username=test_user["username"],
            email="new@example.com",
            password="password",
            display_name="New"
        )
        with pytest.raises(ValueError, match="already exists"):
            await auth_service.create_user(user_data)

    @pytest.mark.asyncio
    async def test_get_first_user(self, db: AsyncSession, test_user: dict) -> None:
        """Test retrieving the first user in the system."""
        auth_service = AuthService(db)
        user = await auth_service.get_first_user()
        assert user is not None
        assert user.username == test_user["username"]
