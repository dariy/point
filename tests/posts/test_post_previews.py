"""Tests for post previews: tokens, links, and lifecycle."""

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.services.post_service import PostService


@pytest.mark.asyncio
async def test_preview_lifecycle_service(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test generating, accessing, and revoking a preview link via service."""
    post = Post(
        title="Draft",
        slug="p-preview",
        content=".",
        author_id=test_user["user"].id,
        status=PostStatus.DRAFT,
    )
    db.add(post)
    await db.commit()

    # Generate
    result = await service.generate_preview_link(post.id)
    assert result is not None
    token, exp = result
    assert token is not None

    # Access
    assert await service.get_post_by_preview_token(token) is not None

    # Revoke
    assert await service.revoke_preview_link(post.id) is True
    assert await service.get_post_by_preview_token(token) is None


@pytest.mark.asyncio
async def test_expired_token_access(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test that expired tokens do not grant access via service."""
    post = Post(
        title="Expired",
        slug="e-preview",
        content=".",
        author_id=test_user["user"].id,
        status=PostStatus.DRAFT,
        preview_token="old-token",
        preview_expires_at=datetime.now(UTC) - timedelta(days=1),
    )
    db.add(post)
    await db.commit()
    assert await service.get_post_by_preview_token("old-token") is None


@pytest.mark.asyncio
async def test_preview_api_workflow(
    client: AsyncClient,
    auth_cookies: dict[str, Any],
    sample_post: Post,
    db: AsyncSession,
) -> None:
    """Test generating and using preview links via API."""
    # Generate
    response = await client.post(
        f"/api/posts/{sample_post.id}/preview", cookies=auth_cookies
    )
    assert response.status_code == 200
    data = response.json()
    assert "preview_url" in data
    token = data["token"]

    # Access with token
    response = await client.get(
        f"/api/posts/{sample_post.id}/preview", params={"token": token}
    )
    assert response.status_code == 200
    assert response.json()["title"] == sample_post.title

    # Access with invalid token
    response = await client.get(
        f"/api/posts/{sample_post.id}/preview", params={"token": "invalid"}
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_preview_api_edge_cases(
    client: AsyncClient, auth_cookies: dict[str, Any], sample_post: Post
) -> None:
    """Test API edge cases for previews like 'not found' branches."""
    # Not found post
    response = await client.post("/api/posts/9999/preview", cookies=auth_cookies)
    assert response.status_code == 404

    # Service returning None (post exists but preview generation fails)
    with patch(
        "app.services.post_service.PostService.generate_preview_link", return_value=None
    ):
        response = await client.post(
            f"/api/posts/{sample_post.id}/preview", cookies=auth_cookies
        )
        assert response.status_code == 404
