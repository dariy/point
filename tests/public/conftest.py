"""Shared fixtures for public API tests."""

import pytest

from app.api import public
from app.config import get_settings
from app.services.cache_service import get_cache


@pytest.fixture
async def enable_cache():
    """Enable cache for specific tests."""
    # Get the singleton instance
    settings = get_settings()
    original_value = settings.cache_enabled

    # Force enable on the singleton
    settings.cache_enabled = True

    # Also force enable on the module-level variable in public router
    # explicitly patching the module variable
    public.settings.cache_enabled = True

    # Ensure cache directory exists
    cache = await get_cache()
    await cache.clear_all()

    yield

    # Restore
    settings.cache_enabled = original_value
    public.settings.cache_enabled = original_value
    await cache.clear_all()
