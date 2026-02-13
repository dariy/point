"""Fixtures for post-related tests."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.post_service import PostService


@pytest.fixture
async def service(db: AsyncSession) -> PostService:
    """Post service fixture."""
    return PostService(db)
