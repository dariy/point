"""Tests for the view count display setting."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta

from app.models.post import Post, PostFormatter, PostStatus
from app.services.settings_service import SettingsService

@pytest.fixture
async def sample_post(db: AsyncSession) -> Post:
    """Create a sample published post."""
    post = Post(
        title="Test View Counts",
        slug="test-view-counts",
        content="Test content",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.utcnow() - timedelta(hours=1),
        view_count=123,
        author_id=1,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post

@pytest.mark.asyncio
async def test_show_view_counts_enabled(client: AsyncClient, db: AsyncSession, sample_post: Post):
    """Test that view counts are shown when enabled."""
    # Enable view counts
    settings_service = SettingsService(db)
    await settings_service.update_setting("show_view_counts", True)
    await db.commit()

    # Check homepage
    response = await client.get("/")
    assert response.status_code == 200
    assert "123 views" in response.text

    # Check single post page
    response = await client.get(f"/posts/{sample_post.slug}")
    assert response.status_code == 200
    assert "124 views" in response.text

@pytest.mark.asyncio
async def test_show_view_counts_disabled(client: AsyncClient, db: AsyncSession, sample_post: Post):
    """Test that view counts are hidden when disabled."""
    # Disable view counts
    settings_service = SettingsService(db)
    await settings_service.update_setting("show_view_counts", False)
    await db.commit()

    # Check homepage
    response = await client.get("/")
    assert response.status_code == 200
    assert "123 views" not in response.text

    # Check single post page
    response = await client.get(f"/posts/{sample_post.slug}")
    assert response.status_code == 200
    assert "123 views" not in response.text

@pytest.mark.asyncio
async def test_admin_always_shows_view_counts(client: AsyncClient, db: AsyncSession, sample_post: Post, auth_cookies: dict):
    """Test that admin dashboard always shows view counts."""
    # Disable view counts for public
    settings_service = SettingsService(db)
    await settings_service.update_setting("show_view_counts", False)
    await db.commit()

    # Check admin dashboard
    response = await client.get("/admin/", cookies=auth_cookies)
    assert response.status_code == 200
    # The dashboard shows total views. sample_post has 123.
    assert "123" in response.text
