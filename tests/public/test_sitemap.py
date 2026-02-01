"""Tests for sitemap functionality."""

import pytest
from datetime import datetime
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.post import Post, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_sitemap_excludes_empty_tags(client: AsyncClient, db: AsyncSession):
    """Test that tags with no posts don't appear in sitemap."""
    # Create tag with posts
    tag_with_posts = Tag(name="HasPosts", slug="has-posts", post_count=5)
    db.add(tag_with_posts)

    # Create tag without posts
    tag_empty = Tag(name="EmptyTag", slug="empty-tag", post_count=0)
    db.add(tag_empty)
    await db.commit()

    # Get sitemap
    resp = await client.get("/sitemap.xml")
    assert resp.status_code == 200

    # Tag with posts should be in sitemap
    assert "/tag/has-posts" in resp.text
    # Empty tag should not be in sitemap
    assert "/tag/empty-tag" not in resp.text


@pytest.mark.asyncio
async def test_sitemap_excludes_draft_posts(client: AsyncClient, db: AsyncSession):
    """Test that draft posts don't appear in sitemap."""
    user = User(username="sitemapuser", email="sitemap@test.com", password_hash="hash", display_name="Sitemap")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create published post
    pub_post = Post(
        title="Published",
        slug="published-sitemap",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(pub_post)

    # Create draft post
    draft_post = Post(
        title="Draft",
        slug="draft-sitemap",
        content="Content",
        status=PostStatus.DRAFT,
        author_id=user.id
    )
    db.add(draft_post)
    await db.commit()

    # Get sitemap
    resp = await client.get("/sitemap.xml")
    assert resp.status_code == 200

    # Published post should be in sitemap
    assert "/posts/published-sitemap" in resp.text
    # Draft post should not be in sitemap
    assert "/posts/draft-sitemap" not in resp.text


@pytest.mark.asyncio
async def test_sitemap_includes_homepage_and_gallery(client: AsyncClient):
    """Test that sitemap includes static pages."""
    resp = await client.get("/sitemap.xml")
    assert resp.status_code == 200

    # Should include homepage
    assert "<loc>http://testserver/</loc>" in resp.text or "<loc>http://test/</loc>" in resp.text
    # Should include gallery/tags page
    assert "/tags" in resp.text
