"""Pytest configuration and fixtures.

Provides common fixtures for testing the Photo Blog application.
"""

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base, get_db
from app.main import app

# Test database URL (in-memory SQLite)
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


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
