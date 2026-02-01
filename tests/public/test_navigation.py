"""Tests for post navigation (previous/next post links)."""

import pytest
from datetime import datetime, timedelta
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.post import Post, PostStatus


@pytest.mark.asyncio
async def test_single_post_first_has_no_previous(client: AsyncClient, db: AsyncSession):
    """Test that first chronological post has no previous post."""
    user = User(username="navuser", email="nav@test.com", password_hash="hash", display_name="Nav")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create first post
    first_post = Post(
        title="First Post",
        slug="first-post",
        content="First",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow() - timedelta(days=10)
    )
    db.add(first_post)
    await db.commit()

    # Get as AJAX to check prev_post
    resp = await client.get(f"/posts/{first_post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    # Should have no previous post
    assert data["prev_post"] is None


@pytest.mark.asyncio
async def test_single_post_last_has_no_next(client: AsyncClient, db: AsyncSession):
    """Test that last chronological post has no next post."""
    user = User(username="navuser2", email="nav2@test.com", password_hash="hash", display_name="Nav2")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create last post (most recent)
    last_post = Post(
        title="Last Post",
        slug="last-post",
        content="Last",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(last_post)
    await db.commit()

    # Get as AJAX to check next_post
    resp = await client.get(f"/posts/{last_post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    # Should have no next post
    assert data["next_post"] is None
