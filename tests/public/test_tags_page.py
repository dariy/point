"""Tests for the tags/gallery page."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_gallery_page_loads(client: AsyncClient) -> None:
    """Test that gallery page loads successfully."""
    response = await client.get("/tags")
    assert response.status_code == 200
    assert "Tags" in response.text
    assert "text/html" in response.headers["content-type"]


@pytest.mark.asyncio
async def test_gallery_shows_posts_with_thumbnails(
    client: AsyncClient, published_post: Post
) -> None:
    """Test gallery shows posts."""
    response = await client.get("/tags")
    assert response.status_code == 200
    assert published_post.title in response.text


@pytest.mark.asyncio
async def test_gallery_empty_state(client: AsyncClient) -> None:
    """Test gallery shows empty state when no images."""
    response = await client.get("/tags")
    assert response.status_code == 200
    assert "No photos yet" in response.text


@pytest.mark.asyncio
async def test_gallery_pagination(
    client: AsyncClient, multiple_posts: list[Post]
) -> None:
    """Test gallery pagination works."""
    response = await client.get("/tags?page=2")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_tags_page_ajax(client: AsyncClient, published_post: Post) -> None:
    """Test tags page with AJAX request returns JSON."""
    response = await client.get("/tags", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    data = response.json()
    assert "posts" in data
    assert "pagination" in data


@pytest.mark.asyncio
async def test_tags_page_with_hidden_posts_tag(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test /tags page filtering out posts with hidden-posts tags for public."""
    user = test_user["user"]

    # Create hidden-posts tag
    hidden_tag = Tag(name="Private", slug="private", is_hidden_posts=True)
    db.add(hidden_tag)

    # Create post with this tag
    post = Post(
        title="Private Post",
        slug="private-post",
        content="Private content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    post.tags.append(hidden_tag)
    db.add(post)
    await db.commit()

    # Public access should not see the post in /tags
    response = await client.get("/tags", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    data = response.json()
    assert all(p["slug"] != "private-post" for p in data["posts"])


@pytest.mark.asyncio
async def test_tags_page_filter_by_slug_complex(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test /tags filtering by slug including descendants."""
    user = test_user["user"]

    # Parent and child tags
    parent = Tag(name="Parent", slug="parent")
    db.add(parent)
    await db.flush()

    child = Tag(name="Child", slug="child")
    child.parents.append(parent)
    db.add(child)
    await db.flush()

    # Post with child tag
    post = Post(
        title="Child Tagged Post",
        slug="child-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    post.tags.append(child)
    db.add(post)
    await db.commit()

    # Filter gallery by parent slug
    response = await client.get("/tags", params={"tag_slug": "parent"}, headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    data = response.json()
    # Should see the post tagged with child
    assert any(p["slug"] == "child-post" for p in data["posts"])
