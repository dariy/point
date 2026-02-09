"""Tests for RSS feed functionality."""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.user import User


@pytest.mark.asyncio
async def test_rss_feed_limit_20_posts(client: AsyncClient, db: AsyncSession):
    """Test that RSS feed limits to 20 most recent posts."""
    user = User(
        username="rssuser",
        email="rss@test.com",
        password_hash="hash",
        display_name="RSS",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create 25 posts
    for i in range(25):
        post = Post(
            title=f"RSS Post {i}",
            slug=f"rss-post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            published_at=datetime.now(UTC) - timedelta(hours=i),
        )
        db.add(post)
    await db.commit()

    # Get RSS feed
    resp = await client.get("/feed.xml")
    assert resp.status_code == 200

    # Count <item> tags in XML
    item_count = resp.text.count("<item>")
    assert item_count == 20  # Should be exactly 20


@pytest.mark.asyncio
async def test_rss_feed_excludes_draft_posts(client: AsyncClient, db: AsyncSession):
    """Test that draft posts don't appear in RSS feed."""
    user = User(
        username="rssdraft",
        email="rssdraft@test.com",
        password_hash="hash",
        display_name="RSS Draft",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create published post
    pub_post = Post(
        title="Published Post",
        slug="published-post",
        content="Public content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
    )
    db.add(pub_post)

    # Create draft post
    draft_post = Post(
        title="Draft Post",
        slug="draft-post",
        content="Draft content",
        status=PostStatus.DRAFT,
        author_id=user.id,
    )
    db.add(draft_post)
    await db.commit()

    # Get RSS feed
    resp = await client.get("/feed.xml")
    assert resp.status_code == 200

    # Published post should be in feed
    assert "Published Post" in resp.text
    # Draft post should not be in feed
    assert "Draft Post" not in resp.text
