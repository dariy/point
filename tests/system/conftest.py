"""Fixtures for system tests."""


import pytest

from app.services.cache_service import FileCache


@pytest.fixture
async def cache(tmp_path) -> FileCache:
    """Create a temporary cache for testing."""
    cache = FileCache(tmp_path / "cache")
    await cache.initialize()
    return cache
