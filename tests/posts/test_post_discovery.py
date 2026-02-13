"""Tests for post discovery: listing, pagination, filtering, and search."""

from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.services.post_service import PostService


@pytest.mark.asyncio
async def test_list_posts_all_filters_service(
    db: AsyncSession,
    service: PostService,
    test_user: dict[str, Any],
    sample_tag: Tag,
) -> None:
    """Test listing with combined filters via service layer."""
    await db.execute(delete(Post))
    p1 = Post(
        title="Featured",
        slug="p1-feat",
        content=".",
        status=PostStatus.PUBLISHED,
        is_featured=True,
        author_id=test_user["user"].id,
    )
    p2 = Post(
        title="Draft",
        slug="p2-draft",
        content=".",
        status=PostStatus.DRAFT,
        author_id=test_user["user"].id,
    )
    p1.tags.append(sample_tag)
    db.add_all([p1, p2])
    await db.commit()

    assert (await service.list_posts(featured_only=True))[1] == 1
    assert (await service.list_posts(status=PostStatus.DRAFT, include_drafts=True))[
        1
    ] == 1
    assert (await service.list_posts(search="Feat"))[1] == 1
    assert (await service.list_posts(tag_id=sample_tag.id))[1] == 1


@pytest.mark.asyncio
async def test_list_posts_pagination_api(
    client: AsyncClient, published_post: Post
) -> None:
    """Test GET /api/posts pagination and response structure."""
    # First page
    response = await client.get("/api/posts", params={"page": 1, "per_page": 10})
    assert response.status_code == 200
    data = response.json()
    assert "posts" in data
    assert "total" in data
    assert "pages" in data
    assert data["page"] == 1

    # Empty result pages
    response = await client.get("/api/posts", params={"status": "draft"})
    assert response.status_code == 200
    if response.json()["total"] == 0:
        assert response.json()["pages"] == 1


@pytest.mark.asyncio
async def test_list_posts_filters_api(
    client: AsyncClient, auth_cookies: dict[str, Any], published_post: Post
) -> None:
    """Test API-level filtering."""
    # Featured filter
    response = await client.get("/api/posts", params={"featured": "true"})
    assert response.status_code == 200

    # Status filter (authorized)
    response = await client.get(
        "/api/posts", params={"status": "published"}, cookies=auth_cookies
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_public_only_branch_service(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test public_only logic excluding hidden tag posts via service."""
    hidden_tag = Tag(name="HiddenTag", slug="ht", is_hidden_posts=True)
    db.add(hidden_tag)
    await db.flush()

    p1 = Post(
        title="Public",
        slug="pub-service",
        content=".",
        status=PostStatus.PUBLISHED,
        author_id=test_user["user"].id,
    )
    p2 = Post(
        title="Hidden",
        slug="hid-service",
        content=".",
        status=PostStatus.PUBLISHED,
        author_id=test_user["user"].id,
    )
    p2.tags.append(hidden_tag)
    db.add_all([p1, p2])
    await db.commit()

    posts, total = await service.list_posts(public_only=True)
    assert total == 1
    assert posts[0].title == "Public"
