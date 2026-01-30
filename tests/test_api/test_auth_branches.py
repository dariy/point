"""Tests for uncovered branches in app/api/auth.py."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.user import User
from app.models.session import Session
from app.services.auth_service import hash_token, hash_password
from datetime import datetime, timedelta


@pytest.mark.asyncio
async def test_login_without_username_no_users(client: AsyncClient, db: AsyncSession):
    """Test login without username when no users exist in system."""
    resp = await client.post("/api/auth/login", json={"name": "password"})
    assert resp.status_code == 401
    assert "No user found" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_login_without_username_with_user(client: AsyncClient, db: AsyncSession):
    """Test login without username falls back to first user."""
    # Create a user
    password_hash = hash_password("correctpassword")
    user = User(
        username="singleuser",
        email="single@test.com",
        password_hash=password_hash,
        display_name="Single User"
    )
    db.add(user)
    await db.commit()
    
    # Login without username (should use first user)
    resp = await client.post("/api/auth/login", json={"name": "correctpassword"})
    assert resp.status_code == 200
    assert "Login successful" in resp.json()["message"]


@pytest.mark.asyncio
async def test_login_invalid_credentials_with_username(client: AsyncClient, db: AsyncSession):
    """Test login with invalid credentials when username is provided."""
    password_hash = hash_password("correctpassword")
    user = User(
        username="testuser",
        email="test@test.com",
        password_hash=password_hash,
        display_name="Test User"
    )
    db.add(user)
    await db.commit()
    
    resp = await client.post("/api/auth/login", json={"username": "testuser", "name": "wrongpassword"})
    assert resp.status_code == 401
    assert "Invalid username or password" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_login_invalid_credentials_without_username(client: AsyncClient, db: AsyncSession):
    """Test login with invalid credentials without username."""
    password_hash = hash_password("correctpassword")
    user = User(
        username="testuser",
        email="test@test.com",
        password_hash=password_hash,
        display_name="Test User"
    )
    db.add(user)
    await db.commit()
    
    resp = await client.post("/api/auth/login", json={"name": "wrongpassword"})
    assert resp.status_code == 401
    assert "Invalid password" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_login_with_remember_me(client: AsyncClient, db: AsyncSession):
    """Test login with remember_me flag sets proper cookie."""
    password_hash = hash_password("password")
    user = User(
        username="rememberuser",
        email="remember@test.com",
        password_hash=password_hash,
        display_name="Remember User"
    )
    db.add(user)
    await db.commit()
    
    resp = await client.post("/api/auth/login", json={
        "username": "rememberuser",
        "name": "password",
        "remember_me": True
    })
    assert resp.status_code == 200
    # Check that set-cookie header exists
    assert "set-cookie" in resp.headers


@pytest.mark.asyncio
async def test_logout_without_session(client: AsyncClient):
    """Test logout without active session."""
    resp = await client.post("/api/auth/logout")
    assert resp.status_code == 200
    assert "Logged out successfully" in resp.json()["message"]


@pytest.mark.asyncio
async def test_change_password_current_incorrect(client: AsyncClient, db: AsyncSession):
    """Test change password with incorrect current password."""
    password_hash = hash_password("oldpassword")
    user = User(
        username="changeuser",
        email="change@test.com",
        password_hash=password_hash,
        display_name="Change User"
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # Create session
    session = Session(
        user_id=user.id,
        token=hash_token("change-token"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    
    resp = await client.post(
        "/api/auth/change-password",
        json={"current_name": "wrongoldpassword", "new_name": "newpassword"},
        headers={"Cookie": "session_token=change-token"}
    )
    assert resp.status_code == 400
    assert "incorrect" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_terminate_session_not_found(client: AsyncClient, db: AsyncSession):
    """Test terminating non-existent session."""
    password_hash = hash_password("password")
    user = User(
        username="termuser",
        email="term@test.com",
        password_hash=password_hash,
        display_name="Term User"
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # Create session
    session = Session(
        user_id=user.id,
        token=hash_token("term-token"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    
    resp = await client.delete(
        "/api/auth/sessions/99999",
        headers={"Cookie": "session_token=term-token"}
    )
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_list_sessions_marks_current(client: AsyncClient, db: AsyncSession):
    """Test list sessions marks current session."""
    password_hash = hash_password("password")
    user = User(
        username="listuser",
        email="list@test.com",
        password_hash=password_hash,
        display_name="List User"
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # Create two sessions
    session1 = Session(
        user_id=user.id,
        token=hash_token("list-token-1"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test1"
    )
    session2 = Session(
        user_id=user.id,
        token=hash_token("list-token-2"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.2",
        user_agent="test2"
    )
    db.add_all([session1, session2])
    await db.commit()
    
    # List sessions using first token
    resp = await client.get(
        "/api/auth/sessions",
        headers={"Cookie": "session_token=list-token-1"}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "sessions" in data
    # At least one session should be marked as current
    assert any(s.get("is_current") for s in data["sessions"])


@pytest.mark.asyncio
async def test_terminate_all_sessions(client: AsyncClient, db: AsyncSession):
    """Test terminating all sessions except current."""
    password_hash = hash_password("password")
    user = User(
        username="termalluser",
        email="termall@test.com",
        password_hash=password_hash,
        display_name="Termall User"
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # Create multiple sessions
    session1 = Session(
        user_id=user.id,
        token=hash_token("termall-token-1"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test1"
    )
    session2 = Session(
        user_id=user.id,
        token=hash_token("termall-token-2"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.2",
        user_agent="test2"
    )
    session3 = Session(
        user_id=user.id,
        token=hash_token("termall-token-3"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.3",
        user_agent="test3"
    )
    db.add_all([session1, session2, session3])
    await db.commit()
    
    # Terminate all except current (using token 1)
    resp = await client.delete(
        "/api/auth/sessions",
        headers={"Cookie": "session_token=termall-token-1"}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "Terminated" in data["message"]
    assert "2" in data["message"]  # Should terminate 2 sessions
