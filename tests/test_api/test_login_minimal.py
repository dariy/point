"""Tests for minimal login (password only)."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import SESSION_COOKIE_NAME
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials."""
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="light",
        email="light@example.com",
        password="testpassword123",
        display_name="Light User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "password": "testpassword123",
        "user": user,
    }


@pytest.mark.asyncio
async def test_login_no_username_success(
    client: AsyncClient, test_user: dict
) -> None:
    """Test successful login without providing username."""
    response = await client.post(
        "/api/auth/login",
        json={
            "name": test_user["password"],  # API expects 'name' field for password
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["message"] == "Login successful"
    assert data["user"]["username"] == "light"
    assert SESSION_COOKIE_NAME in response.cookies


@pytest.mark.asyncio
async def test_login_no_username_invalid_password(
    client: AsyncClient, test_user: dict
) -> None:
    """Test login without username and invalid password."""
    response = await client.post(
        "/api/auth/login",
        json={
            "name": "wrongpassword",  # API expects 'name' field for password
        },
    )

    assert response.status_code == 401
    assert "Invalid password" in response.json()["detail"]


@pytest.mark.asyncio
async def test_login_no_username_no_user(
    client: AsyncClient, db: AsyncSession
) -> None:
    """Test login without username when no users exist in DB."""
    # Note: We don't use the test_user fixture here, so DB should be empty
    # unless other tests ran and didn't clean up (conftest should handle this)

    response = await client.post(
        "/api/auth/login",
        json={
            "name": "anypassword",  # API expects 'name' field for password
        },
    )

    assert response.status_code == 401
    assert "No user found in system" in response.json()["detail"]
