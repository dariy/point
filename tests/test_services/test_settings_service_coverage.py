"""Additional tests for SettingsService coverage."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.settings_service import SettingsService

@pytest.fixture
def settings_service(db: AsyncSession):
    return SettingsService(db)

@pytest.mark.asyncio
async def test_get_all_settings_empty(settings_service: SettingsService):
    """Test getting settings when empty."""
    settings = await settings_service.get_all_settings()
    # Should return defaults from env
    assert "blog_title" in settings
    # The default app_name might be 'Gemini Blog' or 'Point Blog' depending on env. 
    # Just checking it exists is enough or check type
    assert isinstance(settings["blog_title"], str)

@pytest.mark.asyncio
async def test_update_settings_multiple(settings_service: SettingsService):
    """Test updating multiple settings."""
    update_data = {
        "blog_title": "New Name",
        "blog_subtitle": "Footer"
    }
    await settings_service.update_settings(update_data)
    
    # Verify persistence
    fetched = await settings_service.get_all_settings()
    assert fetched["blog_title"] == "New Name"
    
    update_data = {
        "blog_title": "New Title",
        "blog_subtitle": "New Subtitle"
    }
    await settings_service.update_settings(update_data)
    
    fetched = await settings_service.get_all_settings()
    assert fetched["blog_title"] == "New Title"
    assert fetched["blog_subtitle"] == "New Subtitle"

@pytest.mark.asyncio
async def test_get_setting_fallback(settings_service: SettingsService):
    """Test getting setting fallback."""
    # "posts_per_page" is in env defaults
    val = await settings_service.get_setting("posts_per_page")
    assert val is not None
    assert isinstance(val, int)

@pytest.mark.asyncio
async def test_boolean_setting(settings_service: SettingsService):
    """Test boolean setting conversion."""
    # Set boolean via update
    await settings_service.update_setting("enable_analytics", True)
    
    val = await settings_service.get_setting("enable_analytics")
    assert val is True
    assert isinstance(val, bool)

@pytest.mark.asyncio
async def test_int_setting(settings_service: SettingsService):
    """Test integer setting conversion."""
    await settings_service.update_setting("posts_per_page", 50)
    
    val = await settings_service.get_setting("posts_per_page")
    assert val == 50
    assert isinstance(val, int)

@pytest.mark.asyncio
async def test_update_setting_mixed_types(settings_service: SettingsService):
    """Test updating settings with mixed types."""
    await settings_service.update_setting("blog_title", "Title")
    await settings_service.update_setting("posts_per_page", 10)
    await settings_service.update_setting("enable_analytics", False)
    
    all_s = await settings_service.get_all_settings()
    assert all_s["blog_title"] == "Title"
    assert all_s["posts_per_page"] == 10
    assert all_s["enable_analytics"] is False