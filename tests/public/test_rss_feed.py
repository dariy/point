"""Tests for RSS feed generation."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_rss_feed_loads(client: AsyncClient) -> None:
    """Test that RSS feed loads successfully."""
    response = await client.get("/feed.xml")
    assert response.status_code == 200
    assert "application/rss+xml" in response.headers["content-type"]


@pytest.mark.asyncio
async def test_rss_feed_is_valid_xml(client: AsyncClient) -> None:
    """Test that RSS feed is valid XML."""
    response = await client.get("/feed.xml")
    assert response.status_code == 200
    assert '<?xml version="1.0"' in response.text
    assert "<rss version=" in response.text


@pytest.mark.asyncio
async def test_rss_feed_contains_posts(
    client: AsyncClient, published_post: Post
) -> None:
    """Test that RSS feed contains published posts."""
    response = await client.get("/feed.xml")
    assert response.status_code == 200
    assert published_post.title in response.text


@pytest.mark.asyncio
async def test_rss_feed_excludes_drafts(
    client: AsyncClient, draft_post: Post
) -> None:
    """Test that RSS feed excludes draft posts."""
    response = await client.get("/feed.xml")
    assert response.status_code == 200
    assert draft_post.title not in response.text


@pytest.mark.asyncio
async def test_rss_feed_cache_hit(client: AsyncClient, enable_cache, published_post: Post) -> None:
    """Test RSS feed cache hit."""
    await client.get("/feed.xml")
    response = await client.get("/feed.xml")
    assert response.headers.get("X-Cache") == "HIT"


@pytest.mark.asyncio
async def test_rss_feed_with_hidden_posts(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test RSS feed filtering out posts with hidden tags."""
    user = test_user["user"]
    hidden_tag = Tag(name="Hidden Posts", slug="hidden-posts", is_hidden_posts=True)
    db.add(hidden_tag)

    hidden_post = Post(
        title="Hidden RSS Post",
        slug="hidden-rss-post",
        content="Secret content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    hidden_post.tags.append(hidden_tag)
    db.add(hidden_post)
    await db.commit()

    response = await client.get("/feed.xml")
    assert response.status_code == 200
    assert "Hidden RSS Post" not in response.text
