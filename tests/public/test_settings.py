"""Tests for blog settings and context configuration."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.public import get_db_context
from app.models.settings import BlogSettings


@pytest.mark.asyncio
async def test_get_db_context_without_settings(db: AsyncSession):
    """Test get_db_context fetches settings when not provided."""
    # Ensure some settings exist
    setting = BlogSettings(key="blog_title", value="Context Test Title", value_type="string")
    db.add(setting)
    await db.commit()

    # Call directly without settings
    context = await get_db_context(db, blog_settings=None)

    assert "blog_settings" in context
    assert context["blog_settings"]["blog_title"] == "Context Test Title"
    assert context["blog_title"] == "Context Test Title"
    assert "tag_cloud" in context
    assert "tags" in context


@pytest.mark.asyncio
async def test_get_db_context_overrides_blog_title(client: AsyncClient, db: AsyncSession):
    """Test that database blog_title setting overrides default."""
    # Create custom setting
    setting = BlogSettings(key="blog_title", value="Custom Blog Title", value_type="string")
    db.add(setting)
    await db.commit()

    # Request homepage to trigger get_db_context
    resp = await client.get("/")
    assert resp.status_code == 200
    assert "Custom Blog Title" in resp.text


@pytest.mark.asyncio
async def test_get_db_context_overrides_blog_subtitle(client: AsyncClient, db: AsyncSession):
    """Test that database blog_subtitle setting overrides default."""
    setting = BlogSettings(key="blog_subtitle", value="My Custom Subtitle", value_type="string")
    db.add(setting)
    await db.commit()

    resp = await client.get("/")
    assert resp.status_code == 200
    assert "My Custom Subtitle" in resp.text


@pytest.mark.asyncio
async def test_get_db_context_overrides_author_name(client: AsyncClient, db: AsyncSession):
    """Test that database author_name setting overrides default."""
    setting = BlogSettings(key="author_name", value="Jane Doe", value_type="string")
    db.add(setting)
    await db.commit()

    resp = await client.get("/")
    assert resp.status_code == 200
    # Author name appears in footer or metadata
