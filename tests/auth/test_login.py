"""Tests for login API endpoint.

This module contains tests for user login functionality including
single-user mode, remember_me, and various error conditions.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import SESSION_COOKIE_NAME
from app.models.user import User
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService, hash_password


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials.

    Returns:
        Dict with username, password, and user object
    """
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


class TestLogin:
    """Test cases for login endpoint."""

    @pytest.mark.asyncio
    async def test_login_success_with_username(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test successful login with username."""
        response = await client.post(
            "/api/auth/login",
            json={
                "username": test_user["username"],
                "name": test_user["password"],
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Login successful"
        assert data["user"]["username"] == test_user["username"]
        assert SESSION_COOKIE_NAME in response.cookies

    @pytest.mark.asyncio
    async def test_login_success_without_username(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test successful login without username (single-user mode)."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": test_user["password"],
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Login successful"
        assert data["user"]["username"] == test_user["username"]
        assert SESSION_COOKIE_NAME in response.cookies

    @pytest.mark.asyncio
    async def test_login_invalid_password_with_username(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test login with invalid password when username provided."""
        response = await client.post(
            "/api/auth/login",
            json={
                "username": test_user["username"],
                "name": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert "Invalid username or password" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_invalid_password_without_username(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test login with invalid password in single-user mode."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert "Invalid password" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_no_user_found_empty_db(
        self, client: AsyncClient, db: AsyncSession
    ) -> None:
        """Test login without username when no users exist in system."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": "password",
            },
        )
        assert response.status_code == 401
        assert "No user found" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_with_remember_me_true(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test login with remember_me=True flag."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": test_user["password"],
                "remember_me": True,
            },
        )

        assert response.status_code == 200
        assert SESSION_COOKIE_NAME in response.cookies

    @pytest.mark.asyncio
    async def test_login_with_remember_me_false(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test login with remember_me=False (session cookie)."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": test_user["password"],
                "remember_me": False,
            },
        )

        assert response.status_code == 200
        assert SESSION_COOKIE_NAME in response.cookies

    @pytest.mark.asyncio
    async def test_login_no_user_in_system(
        self, client: AsyncClient, db: AsyncSession
    ) -> None:
        """Test login without username when no users exist (coverage test)."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": "anypassword",
            },
        )

        assert response.status_code == 401
        assert "No user found" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_auth_fails_with_username(
        self, client: AsyncClient, db: AsyncSession
    ) -> None:
        """Test authentication failure with username provided (coverage test)."""
        user = User(
            username="testuser",
            email="test@example.com",
            password_hash=hash_password("correctpassword"),
            display_name="Test User",
        )
        db.add(user)
        await db.commit()

        response = await client.post(
            "/api/auth/login",
            json={
                "username": "testuser",
                "name": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert "Invalid username or password" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_auth_fails_without_username(
        self, client: AsyncClient, db: AsyncSession
    ) -> None:
        """Test authentication failure without username (coverage test)."""
        user = User(
            username="light",
            email="light@example.com",
            password_hash=hash_password("correctpassword"),
            display_name="light",
        )
        db.add(user)
        await db.commit()

        response = await client.post(
            "/api/auth/login",
            json={
                "name": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert "Invalid password" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_remember_me_cookie_settings(
        self, client: AsyncClient, db: AsyncSession
    ) -> None:
        """Test cookie settings with remember_me (coverage test)."""
        user = User(
            username="cookieuser",
            email="cookie@example.com",
            password_hash=hash_password("password123"),
            display_name="Cookie User",
        )
        db.add(user)
        await db.commit()

        # Test with remember_me=True
        response_true = await client.post(
            "/api/auth/login",
            json={
                "username": "cookieuser",
                "name": "password123",
                "remember_me": True,
            },
        )

        assert response_true.status_code == 200
        assert SESSION_COOKIE_NAME in response_true.cookies
        data = response_true.json()
        assert data["message"] == "Login successful"
        assert data["user"]["username"] == "cookieuser"

        # Test with remember_me=False
        response_false = await client.post(
            "/api/auth/login",
            json={
                "username": "cookieuser",
                "name": "password123",
                "remember_me": False,
            },
        )

        assert response_false.status_code == 200
        assert SESSION_COOKIE_NAME in response_false.cookies
