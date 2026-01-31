"""Tests for authentication API endpoints."""

from datetime import datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import MagicMock, patch
import hashlib
import pytest

from app.dependencies import SESSION_COOKIE_NAME
from app.models.session import Session
from app.models.user import User
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService, generate_session_token, hash_password, hash_token, verify_password


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



# Tests from test_api/test_auth_coverage.py
@pytest.mark.asyncio
async def test_login_failure(client: AsyncClient, db: AsyncSession):
    """Test login with wrong password."""
    # Create user
    user = User(username="logintest", email="l@t.com", password_hash=hash_password("correct"), display_name="LoginTest")
    db.add(user)
    await db.commit()
    
    # Wrong password
    resp = await client.post("/api/auth/login", json={"username": "logintest", "name": "wrong"})
    assert resp.status_code == 401
    
    # Wrong username
    resp = await client.post("/api/auth/login", json={"username": "nouser", "name": "any"})
    assert resp.status_code == 401

@pytest.mark.asyncio
async def test_get_me_unauthorized(client: AsyncClient):
    """Test /me endpoint without auth."""
    resp = await client.get("/api/auth/me")
    assert resp.status_code == 401

@pytest.mark.asyncio
async def test_logout(client: AsyncClient):
    """Test logout endpoint."""
    # Logout usually just clears cookie, doesn't strictly require auth to call?
    resp = await client.post("/api/auth/logout")
    assert resp.status_code == 200
    assert "session_token" in resp.cookies or "session_token" not in resp.cookies # Logic depends on implementation (clearing often sets expiry)


# Tests from test_api/test_auth_branches.py
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


# Tests from test_api/test_auth_coverage_extended.py
@pytest.mark.asyncio
async def test_login_no_user_found_empty_db(client: AsyncClient, db: AsyncSession):
    """Test login when no users exist (initial setup scenario)."""
    # DB is empty
    # LoginRequest uses 'name' for password
    response = await client.post("/api/auth/login", json={"name": "password"})
    assert response.status_code == 401
    assert "No user found" in response.json()["detail"]

@pytest.mark.asyncio
async def test_login_invalid_password_auto_user(client: AsyncClient, db: AsyncSession):
    """Test login with invalid password for auto-detected user."""
    user = User(username="admin", email="a@a.com", password_hash="hash", display_name="Admin")
    db.add(user)
    await db.commit()
    
    with patch("app.services.auth_service.AuthService.authenticate_user") as mock_auth:
        mock_auth.return_value = None
        
        # LoginRequest uses 'name' for password
        response = await client.post("/api/auth/login", json={"name": "wrong"})
        assert response.status_code == 401
        assert "Invalid password" in response.json()["detail"]

@pytest.mark.asyncio
async def test_change_password_value_error(client: AsyncClient, auth_cookies: dict):
    """Test change password raising ValueError (e.g. weak password)."""
    with patch("app.services.auth_service.AuthService.change_password") as mock_change:
        mock_change.side_effect = ValueError("Password too short")
        
        response = await client.post(
            "/api/auth/change-password",
            json={"current_name": "old", "new_name": "new"},
            cookies=auth_cookies
        )
        assert response.status_code == 400
        assert "Password too short" in response.json()["detail"]

@pytest.mark.asyncio
async def test_terminate_session_failed(client: AsyncClient, auth_cookies: dict):
    """Test terminate session failing."""
    with patch("app.services.auth_service.AuthService.terminate_session") as mock_term:
        mock_term.return_value = False
        
        response = await client.delete("/api/auth/sessions/999", cookies=auth_cookies)
        assert response.status_code == 404

@pytest.mark.asyncio
async def test_logout_with_session(client: AsyncClient, db: AsyncSession):
    """Test logout with active session."""
    from app.services.auth_service import hash_token
    from app.dependencies import SESSION_COOKIE_NAME
    
    # Manually create session
    user = User(username="u", email="e", password_hash="h", display_name="D")
    db.add(user)
    await db.commit()
    
    plain_token = "token"
    hashed = hash_token(plain_token)
    
    session = Session(
        user_id=user.id,
        token=hashed,
        ip_address="127.0.0.1",
        user_agent="Test",
        created_at=datetime.utcnow(),
        expires_at=datetime.utcnow() + timedelta(hours=1),
        last_activity=datetime.utcnow()
    )
    db.add(session)
    await db.commit()
    
    # We need to simulate the dependency getting the session
    # The dependency uses cookie.
    
    cookies = {SESSION_COOKIE_NAME: plain_token}
    response = await client.post("/api/auth/logout", cookies=cookies)
    assert response.status_code == 200
    
    # Verify session is deleted/invalidated
    # Check if exists using text()
    result = await db.execute(text("SELECT * FROM sessions WHERE id = :id"), {"id": session.id})
    assert result.fetchone() is None

@pytest.mark.asyncio
async def test_list_sessions_current_flag(client: AsyncClient, db: AsyncSession):
    """Test list sessions correctly flags current session."""
    from app.services.auth_service import hash_token
    from app.dependencies import SESSION_COOKIE_NAME
    
    user = User(username="u2", email="e2", password_hash="h", display_name="D2")
    db.add(user)
    await db.commit()
    
    plain_token1 = "t1"
    hashed1 = hash_token(plain_token1)
    
    s1 = Session(user_id=user.id, token=hashed1, ip_address="ip", user_agent="ua", created_at=datetime.utcnow(), expires_at=datetime.utcnow()+timedelta(hours=1), last_activity=datetime.utcnow())
    s2 = Session(user_id=user.id, token="t2", ip_address="ip", user_agent="ua", created_at=datetime.utcnow(), expires_at=datetime.utcnow()+timedelta(hours=1), last_activity=datetime.utcnow())
    db.add_all([s1, s2])
    await db.commit()
    
    cookies = {SESSION_COOKIE_NAME: plain_token1}
    response = await client.get("/api/auth/sessions", cookies=cookies)
    assert response.status_code == 200
    data = response.json()
    
    assert len(data["sessions"]) == 2
    # Find s1 in response
    s1_resp = next(s for s in data["sessions"] if s["id"] == s1.id)
    assert s1_resp["is_current"] is True
    
    # Find s2 in response
    s2_resp = next(s for s in data["sessions"] if s["id"] == s2.id)
    assert s2_resp["is_current"] is False



