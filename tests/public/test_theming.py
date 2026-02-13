"""Tests for theming system."""

import pytest
from httpx import AsyncClient

from app.models.post import Post


@pytest.mark.asyncio
async def test_homepage_has_color_scheme_meta(client: AsyncClient) -> None:
    """Test homepage has color-scheme meta tag."""
    response = await client.get("/")
    assert response.status_code == 200
    assert 'name="color-scheme"' in response.text


@pytest.mark.asyncio
async def test_homepage_has_theme_toggle(client: AsyncClient) -> None:
    """Test homepage has theme toggle button."""
    response = await client.get("/")
    assert response.status_code == 200
    assert 'class="theme-toggle"' in response.text


@pytest.mark.asyncio
async def test_homepage_loads_theme_js(client: AsyncClient) -> None:
    """Test homepage loads theme.js script."""
    response = await client.get("/")
    assert response.status_code == 200
    assert 'src="/static/js/theme.js"' in response.text


@pytest.mark.asyncio
async def test_theme_js_file_exists(client: AsyncClient) -> None:
    """Test that theme.js file is accessible and contains expected logic."""
    response = await client.get("/static/js/theme.js")
    assert response.status_code == 200
    assert "ThemeManager" in response.text


@pytest.mark.asyncio
async def test_post_page_has_theme_toggle(client: AsyncClient, published_post: Post) -> None:
    """Test post page has theme toggle button."""
    response = await client.get(f"/posts/{published_post.slug}")
    assert response.status_code == 200
    assert 'class="theme-toggle"' in response.text


@pytest.mark.asyncio
async def test_gallery_has_theme_toggle(client: AsyncClient) -> None:
    """Test gallery page has theme toggle button."""
    response = await client.get("/tags")
    assert response.status_code == 200
    assert 'class="theme-toggle"' in response.text
