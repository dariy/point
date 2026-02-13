"""Tests for user authentication functionality (login, logout, utilities)."""

import pytest
from httpx import AsyncClient

from app.services.auth_service import hash_password, verify_password


class TestAuthUtilities:
    """Tests for password hashing and verification utilities."""

    def test_password_hashing(self) -> None:
        """Test that passwords are correctly hashed and verified."""
        password = "test_password_123"
        hashed = hash_password(password)
        assert hashed != password
        assert verify_password(password, hashed) is True
        assert not verify_password("wrong_password", hashed)

    def test_session_token_generation(self) -> None:
        """Test session token generation uniqueness."""
        from app.services.auth_service import generate_session_token
        t1 = generate_session_token()
        t2 = generate_session_token()
        assert len(t1) > 20
        assert t1 != t2


class TestLoginLogoutAPI:
    """Test cases for login and logout API endpoints."""

    @pytest.mark.asyncio
    async def test_login_success(self, client: AsyncClient, test_user: dict) -> None:
        """Test successful login with valid credentials."""
        response = await client.post(
            "/api/auth/login",
            json={
                "username": test_user["username"],
                "name": test_user["password"]
            }
        )
        assert response.status_code == 200
        # Cookie name is session_token
        assert "session_token" in response.cookies
        assert response.json()["message"] == "Login successful"
        assert response.json()["user"]["username"] == test_user["username"]

    @pytest.mark.asyncio
    async def test_login_invalid_password(self, client: AsyncClient, test_user: dict) -> None:
        """Test login failure with incorrect password."""
        response = await client.post(
            "/api/auth/login",
            json={
                "username": test_user["username"],
                "name": "wrong_password"
            }
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_logout_success(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test successful logout when authenticated."""
        response = await client.post("/api/auth/logout", cookies=auth_cookies)
        assert response.status_code == 200
        assert response.json()["message"] == "Logged out successfully"


class TestPasswordManagement:
    """Test cases for password change functionality."""

    @pytest.mark.asyncio
    async def test_change_password_api(self, client: AsyncClient, auth_cookies: dict, test_user: dict) -> None:
        """Test changing password via API."""
        new_password = "new_secure_password_123"
        # Schema uses current_name and new_name for password fields
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": test_user["password"],
                "new_name": new_password
            },
            cookies=auth_cookies
        )
        assert response.status_code == 200

        # Verify login with new password
        login_resp = await client.post(
            "/api/auth/login",
            json={
                "username": test_user["username"],
                "name": new_password
            }
        )
        assert login_resp.status_code == 200
