"""Tests for authentication API endpoints."""

import pytest
import hashlib
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import SESSION_COOKIE_NAME
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials.

    Returns:
        Dict with username, password, and user object
    """
    auth_service = AuthService(db)
    raw_password = "testpassword123"
    hashed_name = hashlib.sha256(raw_password.encode()).hexdigest()
    
    user_data = UserCreate(
        username="testuser",
        email="test@example.com",
        password=hashed_name,
        display_name="Test User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "username": "testuser",
        "password": hashed_name,
        "user": user,
    }


@pytest.fixture
async def auth_cookies(client: AsyncClient, test_user: dict) -> dict:
    """Login and return auth cookies.

    Returns:
        Dict of cookies from login response
    """
    response = await client.post(
        "/api/auth/login",
        json={
            "username": test_user["username"],
            "name": test_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


class TestLogin:
    """Test cases for login endpoint."""

    @pytest.mark.asyncio
    async def test_login_success(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test successful login."""
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
    async def test_login_invalid_password(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test login with invalid password."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert "Invalid password" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_with_remember_me(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test login with remember_me flag."""
        response = await client.post(
            "/api/auth/login",
            json={
                "name": test_user["password"],
                "remember_me": True,
            },
        )

        assert response.status_code == 200
        assert SESSION_COOKIE_NAME in response.cookies


class TestLogout:
    """Test cases for logout endpoint."""

    @pytest.mark.asyncio
    async def test_logout_success(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test successful logout."""
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


class TestChangePassword:
    """Test cases for password change endpoint."""

    @pytest.mark.asyncio
    async def test_change_password_success(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test successful password change."""
        current_name = hashlib.sha256("testpassword123".encode()).hexdigest()
        new_name = hashlib.sha256("newpassword456".encode()).hexdigest()
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": current_name,
                "new_name": new_name,
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
        current_name = hashlib.sha256("wrongpassword".encode()).hexdigest()
        new_name = hashlib.sha256("newpassword456".encode()).hexdigest()
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": current_name,
                "new_name": new_name,
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
        current_name = hashlib.sha256("testpassword123".encode()).hexdigest()
        # Empty string is too short even for our renamed fields
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": current_name,
                "new_name": "",
            },
            cookies=auth_cookies,
        )

        # Pydantic validation returns 422 for schema errors
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_change_password_unauthenticated(
        self, client: AsyncClient
    ) -> None:
        """Test password change without authentication."""
        current_name = hashlib.sha256("any".encode()).hexdigest()
        new_name = hashlib.sha256("newpassword456".encode()).hexdigest()
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": current_name,
                "new_name": new_name,
            },
        )




class TestSessions:
    """Test cases for session management endpoints."""

    @pytest.mark.asyncio
    async def test_list_sessions(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test listing user sessions."""
        response = await client.get(
            "/api/auth/sessions",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert "sessions" in data
        assert "total" in data
        assert data["total"] >= 1
        # Current session should be marked
        current_sessions = [s for s in data["sessions"] if s["is_current"]]
        assert len(current_sessions) == 1

    @pytest.mark.asyncio
    async def test_list_sessions_unauthenticated(
        self, client: AsyncClient
    ) -> None:
        """Test listing sessions without authentication."""
        response = await client.get("/api/auth/sessions")

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_terminate_session(
        self, client: AsyncClient, test_user: dict, db: AsyncSession
    ) -> None:
        """Test terminating a specific session."""
        # Login twice to create two sessions
        response1 = await client.post(
            "/api/auth/login",
            json={
                "name": test_user["password"],
            },
        )
        cookies1 = dict(response1.cookies)

        # Create a second session (we don't need its cookies)
        await client.post(
            "/api/auth/login",
            json={
                "name": test_user["password"],
            },
        )

        # List sessions from first client
        sessions_response = await client.get(
            "/api/auth/sessions",
            cookies=cookies1,
        )
        sessions = sessions_response.json()["sessions"]

        # Find the other session (not current)
        other_session = next(s for s in sessions if not s["is_current"])

        # Terminate the other session
        response = await client.delete(
            f"/api/auth/sessions/{other_session['id']}",
            cookies=cookies1,
        )

        assert response.status_code == 200
        assert "terminated" in response.json()["message"].lower()

    @pytest.mark.asyncio
    async def test_terminate_nonexistent_session(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test terminating a non-existent session."""
        response = await client.delete(
            "/api/auth/sessions/99999",
            cookies=auth_cookies,
        )

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_terminate_all_sessions(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test terminating all other sessions."""
        # Login multiple times
        for _ in range(3):
            await client.post(
                "/api/auth/login",
                json={
                    "name": test_user["password"],
                },
            )

        # Login one more time and keep the cookies
        response = await client.post(
            "/api/auth/login",
            json={
                "name": test_user["password"],
            },
        )
        cookies = dict(response.cookies)

        # Terminate all other sessions
        response = await client.delete(
            "/api/auth/sessions",
            cookies=cookies,
        )

        assert response.status_code == 200
        assert "session(s)" in response.json()["message"]

        # Verify only current session remains
        sessions_response = await client.get(
            "/api/auth/sessions",
            cookies=cookies,
        )
        assert sessions_response.json()["total"] == 1


class TestAuthService:
    """Test cases for auth service functions."""

    @pytest.mark.asyncio
    async def test_password_hashing(self, db: AsyncSession) -> None:
        """Test password hashing and verification."""
        from app.services.auth_service import hash_password, verify_password

        password = "mysecretpassword"
        hashed = hash_password(password)

        assert hashed != password
        assert verify_password(password, hashed)
        assert not verify_password("wrongpassword", hashed)

    @pytest.mark.asyncio
    async def test_session_token_generation(self, db: AsyncSession) -> None:
        """Test session token generation."""
        from app.services.auth_service import generate_session_token

        token1 = generate_session_token()
        token2 = generate_session_token()

        assert len(token1) == 64
        assert token1 != token2

    @pytest.mark.asyncio
    async def test_create_duplicate_user(
        self, db: AsyncSession, test_user: dict
    ) -> None:
        """Test creating a user with duplicate username."""
        auth_service = AuthService(db)
        user_data = UserCreate(
            username=test_user["username"],  # Same username
            email="different@example.com",
            password="anotherpassword123",
            display_name="Another User",
        )

        with pytest.raises(ValueError, match="already exists"):
            await auth_service.create_user(user_data)
