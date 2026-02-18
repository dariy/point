"""Tests for post navigation (previous/next post links)."""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.models.user import User


@pytest.mark.asyncio
async def test_single_post_first_has_no_previous(client: AsyncClient, db: AsyncSession) -> None:
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
        published_at=datetime.now(UTC) - timedelta(days=10)
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
async def test_single_post_last_has_no_next(client: AsyncClient, db: AsyncSession) -> None:
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
        published_at=datetime.now(UTC)
    )
    db.add(last_post)
    await db.commit()

    # Get as AJAX to check next_post
    resp = await client.get(f"/posts/{last_post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    # Should have no next post
    assert data["next_post"] is None


@pytest.mark.asyncio
async def test_prev_next_post_navigation_full(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test previous and next post navigation logic with middle post."""
    user = test_user["user"]
    now = datetime.now(UTC)
    p1 = Post(
        title="Post 1", slug="p1", content="c",
        status=PostStatus.PUBLISHED, published_at=now - timedelta(days=2),
        formatter=PostFormatter.MARKDOWN, author_id=user.id
    )
    p2 = Post(
        title="Post 2", slug="p2", content="c",
        status=PostStatus.PUBLISHED, published_at=now - timedelta(days=1),
        formatter=PostFormatter.MARKDOWN, author_id=user.id
    )
    p3 = Post(
        title="Post 3", slug="p3", content="c",
        status=PostStatus.PUBLISHED, published_at=now,
        formatter=PostFormatter.MARKDOWN, author_id=user.id
    )
    db.add_all([p1, p2, p3])
    await db.commit()

    # Regular page request
    response = await client.get(f"/posts/{p2.slug}")
    assert response.status_code == 200
    content = response.text
    assert p1.slug in content
    assert p3.slug in content

    # AJAX request
    resp = await client.get(f"/posts/{p2.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["prev_post"]["slug"] == p1.slug
    assert data["next_post"]["slug"] == p3.slug


@pytest.mark.asyncio
async def test_pages_excluded_from_navigation(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test that posts with status PAGE are excluded from navigation."""
    user = test_user["user"]
    now = datetime.now(UTC)

    # Create a published post
    p1 = Post(
        title="Post 1", slug="p1-nav", content="c",
        status=PostStatus.PUBLISHED, published_at=now - timedelta(days=2),
        formatter=PostFormatter.MARKDOWN, author_id=user.id
    )

    # Create a page
    page = Post(
        title="Page", slug="page-nav", content="c",
        status=PostStatus.PAGE, published_at=now - timedelta(days=1),
        formatter=PostFormatter.MARKDOWN, author_id=user.id
    )

    # Create another published post
    p2 = Post(
        title="Post 2", slug="p2-nav", content="c",
        status=PostStatus.PUBLISHED, published_at=now,
        formatter=PostFormatter.MARKDOWN, author_id=user.id
    )

    db.add_all([p1, page, p2])
    await db.commit()

    # Get P1 as AJAX to check next_post (should skip the page and go to p2)
    resp = await client.get(f"/posts/{p1.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["next_post"]["slug"] == p2.slug

    # Get P2 as AJAX to check prev_post (should skip the page and go to p1)
    resp = await client.get(f"/posts/{p2.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["prev_post"]["slug"] == p1.slug

    # Get Page as AJAX, it should have NO navigation
    resp = await client.get(f"/posts/{page.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["prev_post"] is None
    assert data["next_post"] is None
