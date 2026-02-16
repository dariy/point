from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.models.user import User
from app.services.settings_service import SettingsService


@pytest.mark.asyncio
async def test_homepage_featured_pagination_extra_post(client: AsyncClient, db: AsyncSession):
    """Verify homepage fetches per_page + 1 when first post is featured."""
    # Setup
    await db.execute(delete(Post))
    await db.execute(delete(User))

    user = User(username="test", email="t@e.com", password_hash="h", display_name="D")
    db.add(user)
    await db.flush()

    # Create 10 posts, first is featured
    now = datetime.now(UTC)
    for i in range(10):
        db.add(Post(
            title=f"P{i}", slug=f"p{i}", content="C",
            status=PostStatus.PUBLISHED, is_featured=(i == 0),
            author_id=user.id, published_at=now - timedelta(minutes=i)
        ))

    settings_service = SettingsService(db)
    await settings_service.update_setting("posts_per_page", 6)
    await db.commit()

    # Page 1: Should have 7 posts (1 featured + 6 grid)
    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 7
    assert data["posts"][0]["is_featured"] is True
    assert data["pagination"]["total_pages"] == 2 # (10 - 1 - 6) / 6 = 0.5 -> 1 extra page

    # Page 2: Should have 3 posts remaining (P7, P8, P9)
    resp = await client.get("/?page=2", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 3
    assert data["posts"][0]["title"] == "P7"

@pytest.mark.asyncio
async def test_tag_archive_featured_pagination_extra_post(client: AsyncClient, db: AsyncSession):
    """Verify tag archive fetches per_page + 1 when first post is featured."""
    await db.execute(delete(Post))
    await db.execute(delete(Tag))

    user = User(username="test2", email="t2@e.com", password_hash="h", display_name="D")
    tag = Tag(name="T", slug="t")
    db.add_all([user, tag])
    await db.flush()

    now = datetime.now(UTC)
    for i in range(8):
        p = Post(
            title=f"TP{i}", slug=f"tp{i}", content="C",
            status=PostStatus.PUBLISHED, is_featured=(i == 0),
            author_id=user.id, published_at=now - timedelta(minutes=i)
        )
        p.tags.append(tag)
        db.add(p)

    settings_service = SettingsService(db)
    await settings_service.update_setting("posts_per_page", 6)
    await db.commit()

    # Page 1: Should have 7 posts
    resp = await client.get("/tag/t", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 7

    # Page 2: Should have 1 post
    resp = await client.get("/tag/t?page=2", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 1
    assert data["posts"][0]["title"] == "TP7"

@pytest.mark.asyncio
async def test_pagination_boundary_conditions(client: AsyncClient, db: AsyncSession):
    """Test exactly per_page + 1 posts (all on one page)."""
    await db.execute(delete(Post))
    user = await db.scalar(delete(User).returning(User)) # Just reuse or clear
    user = User(username="test3", email="t3@e.com", password_hash="h", display_name="D")
    db.add(user)
    await db.flush()

    now = datetime.now(UTC)
    # 7 posts total, first featured, per_page=6
    for i in range(7):
        db.add(Post(
            title=f"B{i}", slug=f"b{i}", content="C",
            status=PostStatus.PUBLISHED, is_featured=(i == 0),
            author_id=user.id, published_at=now - timedelta(minutes=i)
        ))

    settings_service = SettingsService(db)
    await settings_service.update_setting("posts_per_page", 6)
    await db.commit()

    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 7
    assert data["pagination"]["total_pages"] == 1
    assert data["pagination"]["has_next"] is False
