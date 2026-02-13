"""Tests for sitemap and robots.txt generation."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_sitemap_loads(client: AsyncClient) -> None:
    """Test that sitemap loads successfully."""
    response = await client.get("/sitemap.xml")
    assert response.status_code == 200
    assert "application/xml" in response.headers["content-type"]


@pytest.mark.asyncio
async def test_sitemap_is_valid_xml(client: AsyncClient) -> None:
    """Test that sitemap is valid XML."""
    response = await client.get("/sitemap.xml")
    assert response.status_code == 200
    assert '<?xml version="1.0"' in response.text
    assert "<urlset" in response.text


@pytest.mark.asyncio
async def test_sitemap_contains_posts(
    client: AsyncClient, published_post: Post
) -> None:
    """Test that sitemap contains published posts."""
    response = await client.get("/sitemap.xml")
    assert response.status_code == 200
    assert f"/posts/{published_post.slug}" in response.text


@pytest.mark.asyncio
async def test_sitemap_excludes_drafts(
    client: AsyncClient, draft_post: Post
) -> None:
    """Test that sitemap excludes draft posts."""
    response = await client.get("/sitemap.xml")
    assert response.status_code == 200
    assert draft_post.slug not in response.text


@pytest.mark.asyncio
async def test_sitemap_cache_hit(client: AsyncClient, enable_cache, published_post: Post) -> None:
    """Test sitemap cache hit."""
    await client.get("/sitemap.xml")
    response = await client.get("/sitemap.xml")
    assert response.headers.get("X-Cache") == "HIT"


@pytest.mark.asyncio
async def test_sitemap_with_hidden_posts_tag(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test Sitemap filtering out posts with hidden-posts tags."""
    user = test_user["user"]
    hidden_tag = Tag(name="Private Sitemap", slug="private-sitemap", is_hidden_posts=True)
    db.add(hidden_tag)

    hidden_post = Post(
        title="Private Sitemap Post",
        slug="private-sitemap-post",
        content="Private content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    hidden_post.tags.append(hidden_tag)
    db.add(hidden_post)
    await db.commit()

    response = await client.get("/sitemap.xml")
    assert response.status_code == 200
    assert "private-sitemap-post" not in response.text


@pytest.mark.asyncio
async def test_sitemap_with_publicly_hidden_tag(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test Sitemap filtering out publicly hidden tags."""
    hidden_tag = Tag(name="Secret Tag", slug="secret-tag", is_hidden=True, is_featured=True)
    db.add(hidden_tag)
    await db.commit()

    response = await client.get("/sitemap.xml")
    assert response.status_code == 200
    assert "secret-tag" not in response.text


@pytest.mark.asyncio
async def test_robots_txt_content(client: AsyncClient) -> None:
    """Test robots.txt content."""
    response = await client.get("/robots.txt")
    assert response.status_code == 200
    assert "User-agent: *" in response.text
    assert "Disallow: /api/" in response.text
    assert "Sitemap:" in response.text
