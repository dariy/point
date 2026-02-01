"""Tests for session management API endpoints.

This module contains tests for listing, terminating sessions.
"""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
import hashlib
import pytest

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
    async def test_list_sessions_marks_current_correctly(
        self, client: AsyncClient, test_user: dict, db: AsyncSession
    ) -> None:
        """Test that current session is properly identified in session list."""
        # Create multiple sessions
        login1 = await client.post(
            "/api/auth/login",
            json={"name": test_user["password"]},
        )
        cookies1 = login1.cookies

        await client.post(
            "/api/auth/login",
            json={"name": test_user["password"]},
        )

        # List sessions using first session's cookies
        response = await client.get("/api/auth/sessions", cookies=cookies1)
        assert response.status_code == 200
        data = response.json()

        # Should have at least 2 sessions
        assert data["total"] >= 2

        # Exactly one should be marked as current
        current_count = sum(1 for s in data["sessions"] if s.get("is_current", False))
        assert current_count == 1

    @pytest.mark.asyncio
    async def test_list_sessions_multiple_items(
        self, client: AsyncClient, test_user: dict, db: AsyncSession
    ) -> None:
        """Test session list construction with multiple sessions (coverage test)."""
        # Create multiple sessions
        sessions = []
        for i in range(5):
            response = await client.post(
                "/api/auth/login",
                json={
                    "name": test_user["password"],
                },
            )
            assert response.status_code == 200
            sessions.append(response.cookies)

        # List sessions using first session's cookies
        response = await client.get(
            "/api/auth/sessions",
            cookies=sessions[0],
        )

        assert response.status_code == 200
        data = response.json()

        # Verify SessionListResponse structure
        assert "sessions" in data
        assert "total" in data
        assert data["total"] >= 5

        # Verify each session in the list
        for session in data["sessions"]:
            assert "id" in session
            assert "created_at" in session
            assert "is_current" in session
            assert isinstance(session["is_current"], bool)

        # Exactly one should be marked as current
        current_count = sum(1 for s in data["sessions"] if s["is_current"])
        assert current_count == 1

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

        # Create a second session
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
        assert "not found" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_terminate_session_not_found(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test terminating non-existent session (coverage test)."""
        response = await client.delete(
            "/api/auth/sessions/99999",
            cookies=auth_cookies,
        )

        assert response.status_code == 404
        assert "Session not found" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_terminate_session_success(
        self, client: AsyncClient, test_user: dict, db: AsyncSession
    ) -> None:
        """Test successful session termination (coverage test)."""
        # Create two sessions
        response1 = await client.post(
            "/api/auth/login",
            json={"name": test_user["password"]},
        )
        cookies1 = response1.cookies

        await client.post(
            "/api/auth/login",
            json={"name": test_user["password"]},
        )

        # Get session list to find a non-current session
        list_response = await client.get("/api/auth/sessions", cookies=cookies1)
        sessions = list_response.json()["sessions"]
        other_session = next(s for s in sessions if not s["is_current"])

        # Terminate the other session
        response = await client.delete(
            f"/api/auth/sessions/{other_session['id']}",
            cookies=cookies1,
        )

        assert response.status_code == 200
        assert response.json()["message"] == "Session terminated"

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
        data = response.json()
        assert "session(s)" in data["message"]
        assert "Terminated" in data["message"]

        # Verify only current session remains
        sessions_response = await client.get(
            "/api/auth/sessions",
            cookies=cookies,
        )
        assert sessions_response.json()["total"] == 1

    @pytest.mark.asyncio
    async def test_terminate_all_sessions_message(
        self, client: AsyncClient, test_user: dict
    ) -> None:
        """Test terminate all sessions message format (coverage test)."""
        # Create multiple sessions
        for _ in range(3):
            await client.post(
                "/api/auth/login",
                json={"name": test_user["password"]},
            )

        # Login one more time and keep cookies
        response = await client.post(
            "/api/auth/login",
            json={"name": test_user["password"]},
        )
        cookies = response.cookies

        # Terminate all other sessions
        response = await client.delete("/api/auth/sessions", cookies=cookies)

        assert response.status_code == 200
        data = response.json()
        assert "Terminated" in data["message"]
        assert "session(s)" in data["message"]
        # Verify it contains a number
        assert any(char.isdigit() for char in data["message"])
