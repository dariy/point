"""Additional auth API tests to increase coverage."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from passlib.context import CryptContext

from app.models.user import User
from app.models.session import Session as DBSession

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


@pytest.mark.asyncio
async def test_login_no_users_in_database(client: AsyncClient, db: AsyncSession):
    """Test login when database is completely empty (no users exist)."""
    # Don't create any users
    # Try to login without username (single-user mode)
    resp = await client.post("/api/auth/login", json={
        "name": "testpassword"  # No username = single-user mode
    })

    # Should get 401 with "No user found in system"
    assert resp.status_code == 401
    assert "No user found" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_login_with_username_wrong_password(client: AsyncClient, db: AsyncSession):
    """Test login with correct username but wrong password."""
    # Create user with hashed password
    password_hash = pwd_context.hash("correctpassword")
    user = User(
        username="testuser",
        email="test@example.com",
        password_hash=password_hash,
        display_name="Test User"
    )
    db.add(user)
    await db.commit()

    # Try login with wrong password
    resp = await client.post("/api/auth/login", json={
        "username": "testuser",
        "name": "wrongpassword"
    })

    # Should get 401
    assert resp.status_code == 401
    assert "Invalid username or password" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_login_single_user_mode_wrong_password(client: AsyncClient, db: AsyncSession):
    """Test login in single-user mode (no username) with wrong password."""
    # Create user
    password_hash = pwd_context.hash("correctpassword")
    user = User(
        username="admin",
        email="admin@example.com",
        password_hash=password_hash,
        display_name="Admin"
    )
    db.add(user)
    await db.commit()

    # Try login without username (single-user mode) but wrong password
    resp = await client.post("/api/auth/login", json={
        "name": "wrongpassword"
    })

    # Should get 401
    assert resp.status_code == 401
    assert "Invalid password" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_login_with_remember_me_true(client: AsyncClient, db: AsyncSession):
    """Test that remember_me=true sets cookie."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="rememberuser",
        email="remember@example.com",
        password_hash=password_hash,
        display_name="Remember User"
    )
    db.add(user)
    await db.commit()

    # Login with remember_me=true
    resp = await client.post("/api/auth/login", json={
        "username": "rememberuser",
        "name": "password123",
        "remember_me": True
    })

    assert resp.status_code == 200
    assert "session_token" in resp.cookies


@pytest.mark.asyncio
async def test_login_without_remember_me(client: AsyncClient, db: AsyncSession):
    """Test that remember_me=false creates session cookie."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="sessionuser",
        email="session@example.com",
        password_hash=password_hash,
        display_name="Session User"
    )
    db.add(user)
    await db.commit()

    # Login without remember_me (defaults to false)
    resp = await client.post("/api/auth/login", json={
        "username": "sessionuser",
        "name": "password123",
        "remember_me": False
    })

    assert resp.status_code == 200
    assert "session_token" in resp.cookies


@pytest.mark.asyncio
async def test_change_password_incorrect_current(client: AsyncClient, db: AsyncSession):
    """Test password change fails when current password is wrong."""
    # Create user
    password_hash = pwd_context.hash("oldpassword")
    user = User(
        username="pwduser",
        email="pwd@example.com",
        password_hash=password_hash,
        display_name="PWD User"
    )
    db.add(user)
    await db.commit()

    # Login
    login_resp = await client.post("/api/auth/login", json={
        "username": "pwduser",
        "name": "oldpassword"
    })
    assert login_resp.status_code == 200

    # Try to change password with wrong current password
    resp = await client.post(
        "/api/auth/change-password",
        json={
            "current_password": "wrongcurrentpassword",
            "new_password": "newpassword123"
        },
        cookies=login_resp.cookies
    )

    # Should get error (400 or 422)
    assert resp.status_code in [400, 422]
    if resp.status_code == 400:
        assert "incorrect" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_list_sessions_current_identification(client: AsyncClient, db: AsyncSession):
    """Test that current session is properly identified in session list."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="sessionlistuser",
        email="sessionlist@example.com",
        password_hash=password_hash,
        display_name="Session List User"
    )
    db.add(user)
    await db.commit()

    # Login to create first session
    login1_resp = await client.post("/api/auth/login", json={
        "username": "sessionlistuser",
        "name": "password123"
    })
    assert login1_resp.status_code == 200
    cookies1 = login1_resp.cookies

    # Create another session (login again from "different device")
    login2_resp = await client.post("/api/auth/login", json={
        "username": "sessionlistuser",
        "name": "password123"
    })
    assert login2_resp.status_code == 200

    # List sessions using first session's cookies
    resp = await client.get("/api/auth/sessions", cookies=cookies1)
    assert resp.status_code == 200
    data = resp.json()

    # Should have 2 sessions
    assert data["total"] >= 2

    # Exactly one should be marked as current
    current_count = sum(1 for s in data["sessions"] if s.get("is_current", False))
    assert current_count == 1


@pytest.mark.asyncio
async def test_get_me_authenticated(client: AsyncClient, db: AsyncSession):
    """Test /me endpoint with valid authenticated session."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="meuser",
        email="me@example.com",
        password_hash=password_hash,
        display_name="Me User"
    )
    db.add(user)
    await db.commit()

    # Login
    login_resp = await client.post("/api/auth/login", json={
        "username": "meuser",
        "name": "password123"
    })
    assert login_resp.status_code == 200

    # Get current user info
    resp = await client.get("/api/auth/me", cookies=login_resp.cookies)
    assert resp.status_code == 200
    data = resp.json()

    assert data["username"] == "meuser"
    assert data["email"] == "me@example.com"
    assert data["display_name"] == "Me User"
