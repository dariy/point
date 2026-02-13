"""Tests for post management: CRUD operations, status changes, and slug logic."""

import logging
from typing import Any
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.schemas.post import PostCreate, PostUpdate
from app.services.auth_service import AuthService
from app.services.post_service import PostService


@pytest.mark.asyncio
async def test_create_post_api_success(
    client: AsyncClient, auth_cookies: dict[str, Any]
) -> None:
    """Test successful post creation via API."""
    response = await client.post(
        "/api/posts",
        json={
            "title": "New Post",
            "content": "Content",
            "excerpt": "E",
            "formatter": "markdown",
        },
        cookies=auth_cookies,
    )
    assert response.status_code == 201
    assert response.json()["title"] == "New Post"


@pytest.mark.asyncio
async def test_create_post_unauthorized(client: AsyncClient) -> None:
    """Test post creation fails without auth."""
    client.cookies.clear()
    response = await client.post("/api/posts", json={"title": "T", "content": "C"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_create_post_explicit_slug(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test creating post with explicit slug and ensuring uniqueness."""
    await service.create_post(
        PostCreate(title="T1", content="C", slug="unique"), test_user["user"].id
    )
    p2 = await service.create_post(
        PostCreate(title="T2", content="C", slug="unique"), test_user["user"].id
    )
    assert p2.slug == "unique-1"


@pytest.mark.asyncio
async def test_update_post_service_branches(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test service-level update branches including slug changes."""
    post = Post(title="Old", slug="old", content=".", author_id=test_user["user"].id)
    db.add(post)
    await db.commit()

    # Non-existent
    assert await service.update_post(9999, PostUpdate()) is None
    # Wrong author
    assert await service.update_post(post.id, PostUpdate(), author_id=999) is None
    # Valid update
    updated = await service.update_post(
        post.id, PostUpdate(title="New", slug="new-slug")
    )
    assert updated is not None
    assert updated.slug == "new-slug"
    # Same slug
    updated = await service.update_post(post.id, PostUpdate(slug="new-slug"))
    assert updated is not None
    assert updated.slug == "new-slug"
    # Slug that becomes empty (regen from title)
    updated = await service.update_post(post.id, PostUpdate(slug="!!!", title="Regen"))
    assert updated is not None
    assert updated.slug == "regen"


@pytest.mark.asyncio
async def test_update_post_api_success(
    client: AsyncClient, auth_cookies: dict[str, Any], sample_post: Post
) -> None:
    """Test successful post update via API."""
    response = await client.put(
        f"/api/posts/{sample_post.id}",
        json={"title": "Updated Title"},
        cookies=auth_cookies,
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Updated Title"


@pytest.mark.asyncio
async def test_update_post_api_not_found(
    client: AsyncClient, auth_cookies: dict[str, Any]
) -> None:
    """Test post update returns 404 for non-existent post."""
    response = await client.put(
        "/api/posts/9999", json={"title": "X"}, cookies=auth_cookies
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_post_service_branches(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test service-level delete branches."""
    post = Post(title="T", slug="d", content=".", author_id=test_user["user"].id)
    db.add(post)
    await db.commit()

    assert await service.delete_post(9999) is False
    assert await service.delete_post(post.id, author_id=999) is False
    assert await service.delete_post(post.id) is True


@pytest.mark.asyncio
async def test_delete_post_api_success(
    client: AsyncClient, auth_cookies: dict[str, Any], sample_post: Post
) -> None:
    """Test successful post deletion via API."""
    response = await client.delete(f"/api/posts/{sample_post.id}", cookies=auth_cookies)
    assert response.status_code == 204

    # Not found
    response = await client.delete("/api/posts/9999", cookies=auth_cookies)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_publish_flow_api(
    client: AsyncClient, auth_cookies: dict[str, Any], sample_post: Post
) -> None:
    """Test publishing a post via API."""
    response = await client.post(
        f"/api/posts/{sample_post.id}/publish", cookies=auth_cookies
    )
    assert response.status_code == 200
    assert response.json()["status"] == "published"

    # Mock not found after ownership check
    with patch("app.services.post_service.PostService.publish_post", return_value=None):
        response = await client.post(
            f"/api/posts/{sample_post.id}/publish", cookies=auth_cookies
        )
        assert response.status_code == 404


@pytest.mark.asyncio
async def test_withdraw_flow_api(
    client: AsyncClient, auth_cookies: dict[str, Any], published_post: Post
) -> None:
    """Test withdrawing a post via API."""
    response = await client.post(
        f"/api/posts/{published_post.id}/withdraw", cookies=auth_cookies
    )
    assert response.status_code == 200
    assert response.json()["status"] == "draft"

    # Mock not found after ownership check
    with patch("app.services.post_service.PostService.withdraw_post", return_value=None):
        response = await client.post(
            f"/api/posts/{published_post.id}/withdraw", cookies=auth_cookies
        )
        assert response.status_code == 404


@pytest.mark.asyncio
async def test_status_transitions_not_found(
    client: AsyncClient, auth_cookies: dict[str, Any], service: PostService
) -> None:
    """Test that transitions return None for non-existent posts."""
    # Service layer
    assert await service.publish_post(9999) is None
    assert await service.withdraw_post(9999) is None
    assert await service.hide_post(9999) is None

    # API layer
    response = await client.post("/api/posts/9999/publish", cookies=auth_cookies)
    assert response.status_code == 404
    response = await client.post("/api/posts/9999/withdraw", cookies=auth_cookies)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_status_transitions_ownership(
    client: AsyncClient, db: AsyncSession, sample_post: Post
) -> None:
    """Test that status transitions check for ownership."""
    from app.schemas.auth import UserCreate

    auth_service = AuthService(db)
    await auth_service.create_user(
        UserCreate(
            username="other_mgr",
            email="mgr@example.com",
            password="password123",
            display_name="Other Manager",
        )
    )
    await db.commit()

    login_response = await client.post(
        "/api/auth/login",
        json={"username": "other_mgr", "name": "password123"},
    )
    other_cookies = dict(login_response.cookies)

    # Try to publish someone else's post
    response = await client.post(
        f"/api/posts/{sample_post.id}/publish", cookies=other_cookies
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_cache_invalidation_logging(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test cache invalidation hits and failures during management operations."""
    logging.getLogger("app.services.post_service").setLevel(logging.DEBUG)

    post = Post(
        title="T",
        slug="c-manage",
        content=".",
        author_id=test_user["user"].id,
        status=PostStatus.PUBLISHED,
    )
    db.add(post)
    await db.commit()

    # Hit paths
    await service.publish_post(post.id)
    await service.withdraw_post(post.id)
    await service.hide_post(post.id)

    # Hit exception paths
    with patch(
        "app.services.post_service.invalidate_cache_for_post",
        side_effect=Exception("Err"),
    ):
        await service.publish_post(post.id)
        await service.withdraw_post(post.id)
        await service.hide_post(post.id)
        await service.delete_post(post.id)


@pytest.mark.asyncio
async def test_get_existing_slugs_internal(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test internal slug tracking logic used for uniqueness."""
    p = Post(title="T", slug="s-track", content=".", author_id=test_user["user"].id)
    db.add(p)
    await db.commit()

    slugs = await service._get_existing_slugs()
    assert "s-track" in slugs
    slugs_ex = await service._get_existing_slugs(exclude_id=p.id)
    assert "s-track" not in slugs_ex
