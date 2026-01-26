"""Pytest configuration and fixtures.

Provides common fixtures for testing the Photo Blog application.
"""

import os
from collections.abc import AsyncGenerator

# Disable caching in tests BEFORE importing app
os.environ["CACHE_ENABLED"] = "false"

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings  # noqa: E402
from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.schemas.auth import UserCreate  # noqa: E402
from app.services.auth_service import AuthService  # noqa: E402

# Test database URL (in-memory SQLite)
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

# Clear cached settings and reload with test environment
get_settings.cache_clear()


@pytest.fixture
async def db_engine():
    """Create a test database engine.

    Yields:
        Async engine connected to in-memory SQLite
    """
    engine = create_async_engine(
        TEST_DATABASE_URL,
        echo=False,
        connect_args={"check_same_thread": False},
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


@pytest.fixture
async def db(db_engine) -> AsyncGenerator[AsyncSession, None]:
    """Create a test database session.

    Args:
        db_engine: Test database engine fixture

    Yields:
        AsyncSession for database operations
    """
    async_session = async_sessionmaker(
        db_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autocommit=False,
        autoflush=False,
    )

    async with async_session() as session:
        yield session


@pytest.fixture
async def client(db: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Create a test HTTP client.

    Args:
        db: Test database session fixture

    Yields:
        AsyncClient for making HTTP requests to the test app
    """

    async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield db

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials.

    Returns:
        Dict with username, password, and user object
    """
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="testuser_global",
        email="test_global@example.com",
        password="testpassword123",
        display_name="Test User Global",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "username": "testuser_global",
        "password": "testpassword123",
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
            "password": test_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)
