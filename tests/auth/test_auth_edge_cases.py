"""Tests for auth edge cases and error paths."""


import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.services.auth_service import AuthService


class TestAuthEdgeCases:
    """Test cases for error paths in authentication."""

    @pytest.mark.asyncio
    async def test_login_no_users_in_db(self, client: AsyncClient, db: AsyncSession) -> None:
        """Test login when no users exist in the database (lines 60-65)."""
        # Clear users
        from sqlalchemy import delete
        await db.execute(delete(User))
        await db.commit()

        response = await client.post(
            "/api/auth/login",
            json={"name": "any_password"}
        )
        assert response.status_code == 401
        assert "No user found" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_login_invalid_user(self, client: AsyncClient) -> None:
        """Test login with non-existent username (line 67)."""
        response = await client.post(
            "/api/auth/login",
            json={"username": "ghost_user", "name": "any_password"}
        )
        assert response.status_code == 401
        # The API returns "Invalid username or password"
        assert "Invalid username" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_logout_no_session(self, client: AsyncClient) -> None:
        """Test logout when no session exists (line 118 branch)."""
        response = await client.post("/api/auth/logout")
        assert response.status_code == 200
        assert response.json()["message"] == "Logged out successfully"

    @pytest.mark.asyncio
    async def test_change_password_invalid_current(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test change password with incorrect current password (lines 173-177)."""
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": "wrong_current",
                "new_name": "new_pass_123"
            },
            cookies=auth_cookies
        )
        assert response.status_code == 400
        assert "Current password is incorrect" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_change_password_service_error(self, client: AsyncClient, auth_cookies: dict, test_user: dict) -> None:
        """Test change password with a ValueError from service (lines 167-171)."""
        # Trigger ValueError (password too short)
        response = await client.post(
            "/api/auth/change-password",
            json={
                "current_name": test_user["password"],
                "new_name": "short"
            },
            cookies=auth_cookies
        )
        assert response.status_code == 400
        assert "at least 8 characters" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_terminate_nonexistent_session_api(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test terminating a session that doesn't exist via API (line 225)."""
        response = await client.delete("/api/auth/sessions/9999", cookies=auth_cookies)
        assert response.status_code == 404
        assert "Session not found" in response.json()["detail"]


class TestAuthServiceEdgeCases:
    """Unit tests for AuthService edge cases."""

    @pytest.mark.asyncio
    async def test_change_password_user_not_found(self, db: AsyncSession) -> None:
        """Test change_password when user ID is not found (AuthService line 161)."""
        auth_service = AuthService(db)
        # Returns False, not ValueError
        result = await auth_service.change_password(9999, "current_pass", "new_secure_password")
        assert result is False

    @pytest.mark.asyncio
    async def test_cleanup_expired_sessions(self, db: AsyncSession, test_user: dict) -> None:
        """Test cleaning up expired sessions (AuthService lines 239-240)."""
        auth_service = AuthService(db)
        session_obj, token = await auth_service.create_session(test_user["user"].id, "1.1.1.1", "test")

        from datetime import UTC, datetime, timedelta

        from sqlalchemy import update

        from app.models.session import Session
        await db.execute(
            update(Session)
            .where(Session.id == session_obj.id)
            .values(expires_at=datetime.now(UTC) - timedelta(days=1))
        )
        await db.commit()

        result = await auth_service.validate_session(token)
        assert result is None

        from sqlalchemy import select
        db_session = await db.execute(select(Session).where(Session.id == session_obj.id))
        assert db_session.scalar_one_or_none() is None

    @pytest.mark.asyncio
    async def test_terminate_session_user_mismatch(self, db: AsyncSession, test_user: dict) -> None:
        """Test terminating session with wrong user ID (AuthService line 197)."""
        auth_service = AuthService(db)
        session_obj, token = await auth_service.create_session(test_user["user"].id, "1.1.1.1", "test")

        success = await auth_service.terminate_session(session_obj.id, 999)
        assert success is False

        assert await auth_service.validate_session(token) is not None

    @pytest.mark.asyncio
    async def test_session_is_expired_property(self) -> None:
        """Test Session.is_expired property (Session model)."""
        from datetime import UTC, datetime, timedelta

        from app.models.session import Session

        now = datetime.now(UTC)
        s = Session(expires_at=now - timedelta(minutes=1))
        assert s.is_expired is True

        s.expires_at = now + timedelta(minutes=1)
        assert s.is_expired is False
