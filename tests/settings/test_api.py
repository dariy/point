"""Tests for settings API.
"""

from httpx import AsyncClient
import pytest


@pytest.mark.asyncio
async def test_get_settings_unauthorized(client: AsyncClient):
    """Test getting settings without authentication."""
    response = await client.get("/api/settings")
    assert response.status_code == 401
@pytest.mark.asyncio
async def test_get_all_settings(client: AsyncClient, auth_cookies: dict):
    """Test getting all settings."""
    response = await client.get("/api/settings", cookies=auth_cookies)
    assert response.status_code == 200
    data = response.json()
    assert "blog_title" in data
    assert "blog_subtitle" in data
    assert "posts_per_page" in data
@pytest.mark.asyncio
async def test_update_settings(client: AsyncClient, auth_cookies: dict):
    """Test updating settings."""
    new_title = "Updated Blog Title"
    update_data = {
        "settings": {
            "blog_title": new_title,
            "posts_per_page": 15,
            "show_view_counts": False
        }
    }
    response = await client.put("/api/settings", json=update_data, cookies=auth_cookies)
    assert response.status_code == 200
    assert response.json() == {"status": "success"}
    response = await client.get("/api/settings", cookies=auth_cookies)
    data = response.json()
    assert data["blog_title"] == new_title
    assert data["posts_per_page"] == 15
    assert data["show_view_counts"] is False
@pytest.mark.asyncio
async def test_get_specific_setting(client: AsyncClient, auth_cookies: dict):
    """Test getting a specific setting."""
    response = await client.get("/api/settings/blog_title", cookies=auth_cookies)
    assert response.status_code == 200
    # The endpoint returns the value directly
    assert isinstance(response.json(), str)
@pytest.mark.asyncio
async def test_settings_persistence(client: AsyncClient, auth_cookies: dict):
    """Test settings persistence in database."""
    # Update a setting that's not in defaults
    update_data = {
        "settings": {
            "custom_setting": "custom_value"
        }
    }
    await client.put("/api/settings", json=update_data, cookies=auth_cookies)
    response = await client.get("/api/settings/custom_setting", cookies=auth_cookies)
    assert response.status_code == 200
    assert response.json() == "custom_value"