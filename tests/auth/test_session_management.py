"""Tests for active session and security management."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.auth_service import AuthService


class TestSessionAPI:
    """Test cases for session management API endpoints."""

    @pytest.mark.asyncio
    async def test_list_sessions(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test listing active sessions for the current user."""
        response = await client.get("/api/auth/sessions", cookies=auth_cookies)
        assert response.status_code == 200
        data = response.json()
        sessions = data["sessions"]
        assert len(sessions) >= 1
        assert any(s["is_current"] for s in sessions)

    @pytest.mark.asyncio
    async def test_terminate_session(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test terminating a specific session via API."""
        # Get list first
        list_resp = await client.get("/api/auth/sessions", cookies=auth_cookies)
        session_id = list_resp.json()["sessions"][0]["id"]

        response = await client.delete(f"/api/auth/sessions/{session_id}", cookies=auth_cookies)
        assert response.status_code == 200
        assert "terminated" in response.json()["message"].lower()

    @pytest.mark.asyncio
    async def test_terminate_all_sessions(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test terminating all other sessions via API."""
        response = await client.delete("/api/auth/sessions", cookies=auth_cookies)
        assert response.status_code == 200
        assert "Terminated" in response.json()["message"]


class TestAuthServiceSessions:
    """Unit tests for AuthService session operations."""

    @pytest.mark.asyncio
    async def test_session_lifecycle(self, db: AsyncSession, test_user: dict) -> None:
        """Test creating, validating, and terminating a session."""
        auth_service = AuthService(db)
        user = test_user["user"]

        # 1. Create
        session_obj, token = await auth_service.create_session(user.id, "1.2.3.4", "agent")
        assert token is not None

        # 2. Validate
        valid_user = await auth_service.validate_session(token)
        assert valid_user is not None
        assert valid_user.id == user.id

        # 3. Terminate with exclusion
        # Create another session first
        s2_obj, t2 = await auth_service.create_session(user.id, "5.6.7.8", "other")

        count = await auth_service.terminate_all_sessions(user.id, except_session_id=session_obj.id)
        assert count == 1

        # Verify exclusion
        assert await auth_service.validate_session(token) is not None
        assert await auth_service.validate_session(t2) is None

    @pytest.mark.asyncio
    async def test_validate_nonexistent_token(self, db: AsyncSession) -> None:
        """Test validating a token that does not exist."""
        auth_service = AuthService(db)
        assert await auth_service.validate_session("ghost_token") is None
