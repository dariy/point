"""Extended coverage tests for Auth API."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from unittest.mock import MagicMock, patch

from app.models.user import User
from app.models.session import Session
from datetime import datetime, timedelta

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
