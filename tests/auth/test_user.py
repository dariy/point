"""Tests for current user (/me) API endpoint.

This module contains tests for getting current user information.
"""


import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials."""
    auth_service = AuthService(db)
    password = "testpassword123"

    user_data = UserCreate(
        username="testuser",
        email="test@example.com",
        password=password,
        display_name="Test User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "username": "testuser",
        "password": password,
        "user": user,
    }


@pytest.fixture
async def auth_cookies(client: AsyncClient, test_user: dict) -> dict:
    """Login and return auth cookies."""
    response = await client.post(
        "/api/auth/login",
        json={
            "username": test_user["username"],
            "name": test_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


class TestGetMe:
    """Test cases for /me endpoint."""

    @pytest.mark.asyncio
    async def test_get_me_authenticated(
        self, client: AsyncClient, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test getting current user info when authenticated."""
        response = await client.get(
            "/api/auth/me",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["username"] == test_user["username"]
        assert data["email"] == "test@example.com"
        assert data["display_name"] == "Test User"

    @pytest.mark.asyncio
    async def test_get_me_unauthenticated(self, client: AsyncClient) -> None:
        """Test getting current user info without authentication."""
        response = await client.get("/api/auth/me")

        assert response.status_code == 401
        assert "Not authenticated" in response.json()["detail"]
