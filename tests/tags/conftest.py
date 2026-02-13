"""Fixtures for tag tests."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.tag_service import TagService


@pytest.fixture
def service(db: AsyncSession):
    """Tag service fixture."""
    return TagService(db)
