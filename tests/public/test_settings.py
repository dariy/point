"""Tests for blog settings and common template context."""

from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.public import get_db_context
from app.models.post import Post, PostStatus
from app.services.settings_service import SettingsService


@pytest.mark.asyncio
async def test_get_common_context(client: AsyncClient) -> None:
    """Test common context indirectly via any route."""
    response = await client.get("/")
    assert response.status_code == 200
    assert "My Photo Blog" in response.text


@pytest.mark.asyncio
async def test_get_db_context_user_authenticated(db: AsyncSession, test_user: dict) -> None:
    """Test get_db_context with authenticated user."""
    user = test_user["user"]
    context = await get_db_context(db, user=user)
    assert "tag_groups" in context
    assert "blog_settings" in context


@pytest.mark.asyncio
async def test_get_db_context_with_about_post(db: AsyncSession, test_user: dict) -> None:
    """Test get_db_context with about post configured."""
    user = test_user["user"]
    about_post = Post(
        title="About Me",
        slug="about-me",
        content="This is about me",
        status=PostStatus.PUBLISHED,
        author_id=user.id
    )
    db.add(about_post)
    await db.commit()

    settings_service = SettingsService(db)
    await settings_service.update_settings({"about_post_id": about_post.id})

    context = await get_db_context(db)
    assert context["about_post_slug"] == "about-me"


@pytest.mark.asyncio
async def test_get_db_context_full_settings(db: AsyncSession) -> None:
    """Test get_db_context with all blog settings present."""
    settings_service = SettingsService(db)
    await settings_service.update_setting("blog_title", "Custom Title")
    await settings_service.update_setting("blog_subtitle", "Custom Subtitle")
    await settings_service.update_setting("author_name", "Custom Author")
    await db.commit()

    context = await get_db_context(db)
    assert context["blog_title"] == "Custom Title"
    assert context["blog_subtitle"] == "Custom Subtitle"
    assert context["author_name"] == "Custom Author"


@pytest.mark.asyncio
async def test_get_db_context_missing_settings(db: AsyncSession) -> None:
    """Test get_db_context when blog settings are missing."""
    with patch("app.services.settings_service.SettingsService.get_all_settings") as mock_get:
        mock_get.return_value = {}
        context = await get_db_context(db)
        assert context["blog_settings"] == {}
