"""Tests for AuthService session management operations.

This module contains unit tests for session creation, validation, and cleanup.
"""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session
from app.models.user import User
from app.services.auth_service import AuthService


@pytest.fixture
def auth_service(db: AsyncSession):
    """Create AuthService instance with test database."""
    return AuthService(db)


# =============================================================================
# Session Management Tests
# =============================================================================


class TestSessionManagement:
    """Test cases for session creation, validation, and cleanup."""

    @pytest.mark.asyncio
    async def test_create_session(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test session creation."""
        # Create a user first
        user = User(
            username="sessionuser",
            email="session@example.com",
            password_hash="hash",
            display_name="Session User",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Create session
        session, token = await auth_service.create_session(
            user_id=user.id,
            ip_address="127.0.0.1",
            user_agent="Test Agent",
            remember_me=False,
        )

        assert token is not None
        assert len(token) == 64
        assert session is not None

        # Verify session in database
        result = await db.execute(select(Session).where(Session.user_id == user.id))
        session = result.scalar_one_or_none()
        assert session is not None

    @pytest.mark.asyncio
    async def test_validate_session_success(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test validating a valid session."""
        # Create user
        user = User(
            username="validuser",
            email="valid@example.com",
            password_hash="hash",
            display_name="Valid User",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Create session
        session, token = await auth_service.create_session(
            user_id=user.id,
            ip_address="127.0.0.1",
            user_agent="Test",
            remember_me=False,
        )

        # Validate session
        validated_user = await auth_service.validate_session(token)

        assert validated_user is not None
        assert validated_user.id == user.id

    @pytest.mark.asyncio
    async def test_validate_session_expired(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test validating an expired session."""
        from app.services.auth_service import hash_token

        user = User(
            username="user_expired",
            email="u@e.com",
            password_hash="h",
            display_name="Expired",
        )
        db.add(user)
        await db.flush()

        # Create expired session
        plain_token = "expired_token"
        session = Session(
            user_id=user.id,
            token=hash_token(plain_token),
            expires_at=datetime.utcnow() - timedelta(hours=1),
            ip_address="127.0.0.1",
            user_agent="test",
        )
        db.add(session)
        await db.commit()

        # Try to validate expired session
        found = await auth_service.validate_session(plain_token)
        assert found is None

        # Verify session was deleted
        result = await db.execute(
            select(Session).where(Session.token == hash_token(plain_token))
        )
        assert result.scalars().first() is None

    @pytest.mark.asyncio
    async def test_validate_session_not_found(
        self, auth_service: AuthService
    ) -> None:
        """Test validating a non-existent session."""
        result = await auth_service.validate_session("nonexistent_token")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_user_sessions(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test getting all sessions for a user."""
        # Create user
        user = User(
            username="multiuser",
            email="multi@example.com",
            password_hash="hash",
            display_name="Multi User",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Create multiple sessions
        for i in range(3):
            await auth_service.create_session(
                user_id=user.id,
                ip_address=f"127.0.0.{i}",
                user_agent=f"Agent {i}",
                remember_me=False,
            )

        # Get sessions
        sessions = await auth_service.get_user_sessions(user.id)

        assert len(sessions) == 3

    @pytest.mark.asyncio
    async def test_terminate_session_success(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test terminating a specific session."""
        # Create user
        user = User(
            username="termuser",
            email="term@example.com",
            password_hash="hash",
            display_name="Term User",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Create session
        created_session, token = await auth_service.create_session(
            user_id=user.id,
            ip_address="127.0.0.1",
            user_agent="Test",
            remember_me=False,
        )

        # Get session from database
        result = await db.execute(select(Session).where(Session.user_id == user.id))
        session = result.scalar_one()

        # Terminate session
        success = await auth_service.terminate_session(session.id, user.id)

        assert success is True

        # Verify session is deleted
        result = await db.execute(select(Session).where(Session.id == session.id))
        assert result.scalar_one_or_none() is None

    @pytest.mark.asyncio
    async def test_terminate_session_not_found(
        self, auth_service: AuthService
    ) -> None:
        """Test terminating non-existent session."""
        result = await auth_service.terminate_session(999, 1)
        assert result is False

    @pytest.mark.asyncio
    async def test_terminate_all_sessions(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test terminating all sessions except current."""
        # Create user
        user = User(
            username="termalluser",
            email="termall@example.com",
            password_hash="hash",
            display_name="Termall User",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Create multiple sessions
        for i in range(4):
            await auth_service.create_session(
                user_id=user.id,
                ip_address=f"127.0.0.{i}",
                user_agent=f"Agent {i}",
                remember_me=False,
            )

        # Get first session ID
        result = await db.execute(
            select(Session).where(Session.user_id == user.id).limit(1)
        )
        current_session = result.scalar_one()

        # Terminate all except current
        count = await auth_service.terminate_all_sessions(user.id, current_session.id)

        assert count == 3

        # Verify only current session remains
        result = await db.execute(select(Session).where(Session.user_id == user.id))
        remaining_sessions = result.scalars().all()
        assert len(remaining_sessions) == 1

    @pytest.mark.asyncio
    async def test_cleanup_expired_sessions(
        self, auth_service: AuthService, db: AsyncSession
    ) -> None:
        """Test cleaning up expired sessions."""
        # Create sessions - one expired, one valid
        s1 = Session(
            user_id=1,
            token="t1",
            expires_at=datetime.utcnow() - timedelta(hours=1),
            ip_address="1",
            user_agent="1",
        )
        s2 = Session(
            user_id=1,
            token="t2",
            expires_at=datetime.utcnow() + timedelta(hours=1),
            ip_address="2",
            user_agent="2",
        )
        db.add_all([s1, s2])
        await db.commit()

        # Cleanup expired
        count = await auth_service.cleanup_expired_sessions()
        assert count == 1

        # Verify s1 is gone
        res = await db.execute(select(Session).where(Session.token == "t1"))
        assert res.scalars().first() is None

        # Verify s2 remains
        res = await db.execute(select(Session).where(Session.token == "t2"))
        assert res.scalars().first() is not None
