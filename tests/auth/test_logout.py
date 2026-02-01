"""Tests for logout API endpoint.

This module contains tests for user logout functionality.
"""

from datetime import datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
import hashlib
import pytest

from app.dependencies import SESSION_COOKIE_NAME
from app.models.session import Session
from app.models.user import User
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService, hash_password, hash_token


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


class TestLogout:
    """Test cases for logout endpoint."""

    @pytest.mark.asyncio
    async def test_logout_success(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test successful logout with active session."""
        response = await client.post(
            "/api/auth/logout",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert response.json()["message"] == "Logged out successfully"

    @pytest.mark.asyncio
    async def test_logout_without_session(self, client: AsyncClient) -> None:
        """Test logout without active session."""
        response = await client.post("/api/auth/logout")

        assert response.status_code == 200
        assert response.json()["message"] == "Logged out successfully"

    @pytest.mark.asyncio
    async def test_logout_deletes_session(
        self, client: AsyncClient, db: AsyncSession
    ) -> None:
        """Test logout actually deletes the session from database."""
        user = User(
            username="logout_user",
            email="logout@test.com",
            password_hash=hash_password("testpass"),
            display_name="Logout User",
        )
        db.add(user)
        await db.commit()

        plain_token = "test_token"
        hashed = hash_token(plain_token)

        session = Session(
            user_id=user.id,
            token=hashed,
            ip_address="127.0.0.1",
            user_agent="Test",
            created_at=datetime.utcnow(),
            expires_at=datetime.utcnow() + timedelta(hours=1),
            last_activity=datetime.utcnow(),
        )
        db.add(session)
        await db.commit()

        cookies = {SESSION_COOKIE_NAME: plain_token}
        response = await client.post("/api/auth/logout", cookies=cookies)
        assert response.status_code == 200

        # Verify session is deleted
        result = await db.execute(
            text("SELECT * FROM sessions WHERE id = :id"), {"id": session.id}
        )
        assert result.fetchone() is None
