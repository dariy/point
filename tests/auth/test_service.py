"""Additional tests for AuthService coverage."""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import pytest

from app.models.session import Session
from app.models.user import User
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService, verify_password


@pytest.fixture
def auth_service(db: AsyncSession):
    return AuthService(db)

@pytest.mark.asyncio
async def test_create_user_duplicate(auth_service: AuthService, db: AsyncSession):
    """Test creating user with duplicate username raises ValueError."""




    user_data = UserCreate(username="duplicate", email="d@e.com", password="password123", display_name="Display")
    await auth_service.create_user(user_data)
    
    with pytest.raises(ValueError):
        await auth_service.create_user(user_data)

@pytest.mark.asyncio
async def test_authenticate_user_invalid(auth_service: AuthService, db: AsyncSession):
    """Test authentication with invalid credentials."""
    user_data = UserCreate(username="user1", email="u@e.com", password="password123", display_name="U")
    await auth_service.create_user(user_data)
    
    # Wrong password
    assert await auth_service.authenticate_user("user1", "wrong") is None
    
    # Non-existent user
    assert await auth_service.authenticate_user("nobody", "p") is None

@pytest.mark.asyncio
async def test_validate_session_expired(auth_service: AuthService, db: AsyncSession):
    """Test validating an expired session."""
    user = User(username="user_expired", email="u@e.com", password_hash="h", display_name="Expired")
    db.add(user)
    await db.flush()
    
    # Create expired session
    session = Session(
        user_id=user.id,
        token="hashed_token",
        expires_at=datetime.utcnow() - timedelta(hours=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    
    # Mock hash_token to return "hashed_token" for "plain"
    with pytest.MonkeyPatch().context() as m:
        m.setattr("app.services.auth_service.hash_token", lambda x: "hashed_token")
        found = await auth_service.validate_session("plain")
        assert found is None
        
        # Verify session was deleted
        result = await db.execute(select(Session).where(Session.token == "hashed_token"))
        assert result.scalars().first() is None

@pytest.mark.asyncio
async def test_validate_session_not_found(auth_service: AuthService):
    """Test validating a non-existent session."""
    assert await auth_service.validate_session("nonexistent") is None

@pytest.mark.asyncio
async def test_terminate_session_not_found(auth_service: AuthService):
    """Test terminating non-existent session."""
    assert await auth_service.terminate_session(999, 1) is False

@pytest.mark.asyncio
async def test_change_password_invalid(auth_service: AuthService, db: AsyncSession):
    """Test password change edge cases."""
    user_data = UserCreate(username="cpuser", email="c@p.com", password="oldpassword", display_name="C")
    user = await auth_service.create_user(user_data)
    
    # Too short
    with pytest.raises(ValueError):
        await auth_service.change_password(user.id, "oldpassword", "short")
    
    # Wrong current
    assert await auth_service.change_password(user.id, "wrong", "newpassword123") is False
    
    # User not found
    assert await auth_service.change_password(999, "oldpassword", "newpassword123") is False

@pytest.mark.asyncio
async def test_cleanup_expired_sessions(auth_service: AuthService, db: AsyncSession):
    """Test cleaning up expired sessions."""
    s1 = Session(user_id=1, token="t1", expires_at=datetime.utcnow() - timedelta(hours=1), ip_address="1", user_agent="1")
    s2 = Session(user_id=1, token="t2", expires_at=datetime.utcnow() + timedelta(hours=1), ip_address="2", user_agent="2")
    db.add_all([s1, s2])
    await db.commit()
    
    count = await auth_service.cleanup_expired_sessions()
    assert count == 1
    
    # Verify s1 is gone
    res = await db.execute(select(Session).where(Session.token == "t1"))
    assert res.scalars().first() is None
    
    # Verify s2 remains
    res = await db.execute(select(Session).where(Session.token == "t2"))
    assert res.scalars().first() is not None

def test_verify_password_exception():
    """Test verify_password with exception."""
    # This might be hard to trigger naturally, but we can mock it
    assert verify_password("p", None) is False



