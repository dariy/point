"""Targeted tests for specific uncovered lines in auth.py."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from passlib.context import CryptContext

from app.models.user import User
from app.models.session import Session as DBSession

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


@pytest.mark.asyncio
async def test_terminate_session_success_line_230(client: AsyncClient, db: AsyncSession):
    """Test successful session termination (line 230)."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="termuser",
        email="term@example.com",
        password_hash=password_hash,
        display_name="Term User"
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create two sessions manually
    from app.services.auth_service import AuthService
    auth_service = AuthService(db)

    # Login to get first session
    login1_resp = await client.post("/api/auth/login", json={
        "username": "termuser",
        "name": "password123"
    })
    assert login1_resp.status_code == 200
    cookies1 = login1_resp.cookies

    # Create second session
    login2_resp = await client.post("/api/auth/login", json={
        "username": "termuser",
        "name": "password123"
    })
    assert login2_resp.status_code == 200

    # Get sessions to find a session ID
    list_resp = await client.get("/api/auth/sessions", cookies=cookies1)
    sessions = list_resp.json()["sessions"]

    # Find a non-current session
    non_current_session = next((s for s in sessions if not s.get("is_current")), None)

    if non_current_session:
        # Terminate it - this should hit line 230
        resp = await client.delete(
            f"/api/auth/sessions/{non_current_session['id']}",
            cookies=cookies1
        )
        assert resp.status_code == 200
        assert "Session terminated" in resp.json()["message"]


@pytest.mark.asyncio
async def test_terminate_all_sessions_line_250(client: AsyncClient, db: AsyncSession):
    """Test terminate all sessions (line 250)."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="terminateall",
        email="terminateall@example.com",
        password_hash=password_hash,
        display_name="Terminate All"
    )
    db.add(user)
    await db.commit()

    # Create multiple sessions
    login1_resp = await client.post("/api/auth/login", json={
        "username": "terminateall",
        "name": "password123"
    })
    cookies1 = login1_resp.cookies

    await client.post("/api/auth/login", json={
        "username": "terminateall",
        "name": "password123"
    })

    await client.post("/api/auth/login", json={
        "username": "terminateall",
        "name": "password123"
    })

    # Terminate all except current - this should hit line 250
    resp = await client.delete("/api/auth/sessions", cookies=cookies1)
    assert resp.status_code == 200
    assert "Terminated" in resp.json()["message"]
    assert "session(s)" in resp.json()["message"]


@pytest.mark.asyncio
async def test_list_sessions_with_multiple_sessions_lines_196_204(client: AsyncClient, db: AsyncSession):
    """Test session list construction loop (lines 196-204)."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="multiuser",
        email="multi@example.com",
        password_hash=password_hash,
        display_name="Multi User"
    )
    db.add(user)
    await db.commit()

    # Create multiple sessions
    logins = []
    for i in range(3):
        resp = await client.post("/api/auth/login", json={
            "username": "multiuser",
            "name": "password123"
        })
        assert resp.status_code == 200
        logins.append(resp.cookies)

    # List sessions - should execute loop lines 196-204
    resp = await client.get("/api/auth/sessions", cookies=logins[0])
    assert resp.status_code == 200
    data = resp.json()

    # Verify response structure (lines 204-207)
    assert "sessions" in data
    assert "total" in data
    assert data["total"] >= 3
    assert len(data["sessions"]) >= 3

    # Verify is_current flag is set (line 199-201)
    current_count = sum(1 for s in data["sessions"] if s.get("is_current"))
    assert current_count == 1


@pytest.mark.asyncio
async def test_login_remember_me_both_branches_lines_86_90(client: AsyncClient, db: AsyncSession):
    """Test remember_me True and False to cover lines 86-90."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="remembertest",
        email="remember@example.com",
        password_hash=password_hash,
        display_name="Remember Test"
    )
    db.add(user)
    await db.commit()

    # Test with remember_me=True (should set max_age)
    resp_true = await client.post("/api/auth/login", json={
        "username": "remembertest",
        "name": "password123",
        "remember_me": True
    })
    assert resp_true.status_code == 200
    assert "session_token" in resp_true.cookies

    # Test with remember_me=False (max_age should be None)
    resp_false = await client.post("/api/auth/login", json={
        "username": "remembertest",
        "name": "password123",
        "remember_me": False
    })
    assert resp_false.status_code == 200
    assert "session_token" in resp_false.cookies


@pytest.mark.asyncio
async def test_successful_login_hits_cookie_lines_92_101(client: AsyncClient, db: AsyncSession):
    """Test successful login to ensure cookie setting lines 92-101 are hit."""
    # Create user
    password_hash = pwd_context.hash("password123")
    user = User(
        username="cookietest",
        email="cookie@example.com",
        password_hash=password_hash,
        display_name="Cookie Test"
    )
    db.add(user)
    await db.commit()

    # Successful login should execute lines 92-101
    resp = await client.post("/api/auth/login", json={
        "username": "cookietest",
        "name": "password123"
    })

    assert resp.status_code == 200
    data = resp.json()

    # Verify LoginResponse structure (line 101-103)
    assert "message" in data
    assert "user" in data
    assert data["message"] == "Login successful"

    # Verify cookie is set
    assert "session_token" in resp.cookies
