"""Tests for blog settings management functionality."""

from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.settings import BlogSettings
from app.services.settings_service import SettingsService


class TestSettingsAPI:
    """Test cases for blog settings API endpoints."""

    @pytest.mark.asyncio
    async def test_get_all_settings(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test retrieving all blog settings via API."""
        response = await client.get("/api/settings", cookies=auth_cookies)
        assert response.status_code == 200
        data = response.json()
        assert "blog_title" in data
        assert "posts_per_page" in data

    @pytest.mark.asyncio
    async def test_get_specific_setting(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test retrieving a single setting via API."""
        response = await client.get("/api/settings/blog_title", cookies=auth_cookies)
        assert response.status_code == 200
        # Returns the value directly
        assert isinstance(response.json(), str)

    @pytest.mark.asyncio
    async def test_update_settings(self, client: AsyncClient, auth_cookies: dict) -> None:
        """Test updating multiple settings via API."""
        payload = {
            "settings": {
                "blog_title": "Updated API Title",
                "posts_per_page": 25
            }
        }
        response = await client.put("/api/settings", json=payload, cookies=auth_cookies)
        assert response.status_code == 200
        assert response.json()["status"] == "success"

        # Verify change
        get_resp = await client.get("/api/settings/blog_title", cookies=auth_cookies)
        assert get_resp.json() == "Updated API Title"

    @pytest.mark.asyncio
    async def test_settings_unauthorized(self, client: AsyncClient) -> None:
        """Test that settings endpoints require authentication."""
        for method, url in [("GET", "/api/settings"), ("PUT", "/api/settings")]:
            response = await client.request(method, url)
            assert response.status_code == 401


class TestSettingsService:
    """Unit tests for SettingsService business logic and type conversion."""

    @pytest.fixture
    def service(self, db: AsyncSession) -> SettingsService:
        """Fixture for settings service."""
        return SettingsService(db)

    @pytest.mark.asyncio
    async def test_type_conversions(self, service: SettingsService) -> None:
        """Test conversion between different data types for storage."""
        test_cases = [
            ("int_key", 123, 123, int),
            ("bool_key", True, True, bool),
            ("bool_key_f", False, False, bool),
            ("json_key", {"a": 1}, {"a": 1}, dict),
            ("str_key", "hello", "hello", str),
            ("none_key", None, None, type(None))
        ]

        for key, val, expected, expected_type in test_cases:
            await service.update_setting(key, val)
            result = await service.get_setting(key)
            assert result == expected
            assert isinstance(result, expected_type)

    @pytest.mark.asyncio
    async def test_conversion_error_handling(self, service: SettingsService, db: AsyncSession) -> None:
        """Test handling of invalid data in the database."""
        # Manually insert invalid int
        setting = BlogSettings(key="invalid_int", value="not-an-int", value_type="int")
        db.add(setting)
        await db.commit()

        # Should return the original string on failure
        result = await service.get_setting("invalid_int")
        assert result == "not-an-int"

    @pytest.mark.asyncio
    async def test_env_fallback(self, service: SettingsService) -> None:
        """Test falling back to environment settings when DB is empty."""
        # "blog_title" should exist in default env settings
        val = await service.get_setting("blog_title")
        assert isinstance(val, str)
        assert len(val) > 0

    @pytest.mark.asyncio
    async def test_update_existing_setting(self, service: SettingsService) -> None:
        """Test that updating an existing setting modifies the record instead of creating new."""
        await service.update_setting("duplicate", "first")
        await service.update_setting("duplicate", "second")

        val = await service.get_setting("duplicate")
        assert val == "second"

    @pytest.mark.asyncio
    async def test_update_settings_bulk_existing(self, service: SettingsService) -> None:
        """Test bulk update of existing settings (lines 176-177)."""
        await service.update_setting("bulk_key", "old")
        await service.update_settings({"bulk_key": "new", "other": "value"})

        assert await service.get_setting("bulk_key") == "new"
        assert await service.get_setting("other") == "value"

    @pytest.mark.asyncio
    async def test_get_all_settings_db_override(self, service: SettingsService) -> None:
        """Test that DB settings correctly override env defaults in get_all_settings (line 126)."""
        # "blog_title" usually comes from env
        await service.update_setting("blog_title", "DB Override")

        all_s = await service.get_all_settings()
        assert all_s["blog_title"] == "DB Override"

    @pytest.mark.asyncio
    async def test_get_setting_none_fallback(self, service: SettingsService) -> None:
        """Test fallback to None when key is not in DB or env (line 102)."""
        assert await service.get_setting("completely_unknown_key") is None

    @pytest.mark.asyncio
    async def test_cache_clear_warning(self, service: SettingsService) -> None:
        """Test that cache clearing failures are handled gracefully."""
        with patch("app.services.settings_service.clear_page_cache", side_effect=Exception("Cache down")):
            # Should not raise exception
            await service.update_setting("any", "value")
            await service.update_settings({"bulk": "value"})
