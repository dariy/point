"""Tests for password change API endpoint.

This module contains tests for changing user passwords.
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


class TestChangePassword:
    """Test cases for password change endpoint."""

    @pytest.mark.asyncio
    async def test_change_password_success(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test successful password change."""
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": "testpassword123",
                "new_name": "newpassword456",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert response.json()["message"] == "Password changed successfully"

    @pytest.mark.asyncio
    async def test_change_password_wrong_current(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test password change with wrong current password."""
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": "wrongpassword",
                "new_name": "newpassword456",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 400
        assert "Current password is incorrect" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_change_password_too_short(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test password change with new password too short."""
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": "testpassword123",
                "new_name": "",
            },
            cookies=auth_cookies,
        )

        # Pydantic validation returns 422 for schema errors
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_change_password_unauthenticated(self, client: AsyncClient) -> None:
        """Test password change without authentication."""
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": "any",
                "new_name": "newpassword456",
            },
        )

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_change_password_value_error(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test password change raising ValueError (coverage test)."""
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": "testpassword123",
                "new_name": "short",  # Too short (less than 8 chars)
            },
            cookies=auth_cookies,
        )

        assert response.status_code in [400, 422]

    @pytest.mark.asyncio
    async def test_change_password_current_incorrect(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test password change with incorrect current password (coverage test)."""
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": "wrongpassword",
                "new_name": "newpassword123",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 400
        assert "Current password is incorrect" in response.json()["detail"]
