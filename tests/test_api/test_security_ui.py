"""Tests for security interface routes."""

import pytest
import hashlib
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials."""
    auth_service = AuthService(db)
    raw_password = "testpassword123"
    hashed_name = hashlib.sha256(raw_password.encode()).hexdigest()
    
    user_data = UserCreate(
        username="security_test",
        email="security@example.com",
        password=hashed_name,
        display_name="Security Test User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "username": "security_test",
        "password": hashed_name,
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


class TestSecurityPage:
    """Test cases for security settings page."""

    @pytest.mark.asyncio
    async def test_security_page_requires_auth(self, client: AsyncClient) -> None:
        """Test security page redirects to login without authentication."""
        response = await client.get(
            "/light/security",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_security_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test security page renders when authenticated."""
        response = await client.get(
            "/light/security",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Security Settings" in response.text
        assert "Change Password" in response.text
        assert 'id="password-form"' in response.text

    @pytest.mark.asyncio
    async def test_settings_page_no_longer_has_password_form(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test settings page no longer contains the password change form."""
        response = await client.get(
            "/light/settings",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'id="password-form"' not in response.text
        assert "Update Password" not in response.text
