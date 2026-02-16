from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.services.settings_service import SettingsService


@pytest.mark.asyncio
async def test_homepage_promotes_latest_featured_post(client: AsyncClient, db: AsyncSession, test_user: dict):
    """Verify that the latest featured post is promoted to the top, even if it's old."""
    # Setup - clear existing posts
    await db.execute(delete(Post))

    user = test_user["user"]
    now = datetime.now(UTC)

    # Create 5 posts
    # P0: Most recent, not featured
    # P1: Older, featured (should be promoted)
    # P2: Even older, featured (should NOT be promoted)
    # P3, P4: Not featured

    posts = []
    for i in range(5):
        p = Post(
            title=f"P{i}", slug=f"p{i}", content="C",
            status=PostStatus.PUBLISHED,
            is_featured=(i == 1 or i == 2), # P1 and P2 are featured
            author_id=user.id,
            published_at=now - timedelta(days=i)
        )
        db.add(p)
        posts.append(p)

    settings_service = SettingsService(db)
    await settings_service.update_setting("posts_per_page", 2)
    await db.commit()

    # Page 1: Should have P1 (promoted) + P0 + P2
    # Wait, per_page is 2.
    # Logic: 1 promoted + per_page regular.
    # Total on page 1 should be 3.

    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()

    assert len(data["posts"]) == 3
    assert data["posts"][0]["title"] == "P1" # Latest featured
    assert data["posts"][0]["is_featured"] is True

    assert data["posts"][1]["title"] == "P0" # Most recent regular
    assert data["posts"][2]["title"] == "P2" # Second most recent regular (which is also featured, but not the promoted one)

    # Pagination check
    # Total posts: 5. 1 Promoted. Remaining: 4.
    # Page 1: 1 Promoted + 2 Regular. Remaining: 2.
    # Page 2: 2 Regular.
    # Total pages: 1 + ceil((5 - 1 - 2) / 2) = 1 + ceil(2/2) = 2.

    assert data["pagination"]["total_pages"] == 2
    assert data["pagination"]["has_next"] is True

    # Page 2: Should have P3, P4
    resp = await client.get("/?page=2", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 2
    assert data["posts"][0]["title"] == "P3"
    assert data["posts"][1]["title"] == "P4"

@pytest.mark.asyncio
async def test_tag_archive_promotes_tag_specific_featured_post(client: AsyncClient, db: AsyncSession, test_user: dict):
    """Verify that tag archive promotes the latest featured post for that specific tag."""
    await db.execute(delete(Post))
    await db.execute(delete(Tag))

    user = test_user["user"]
    tag = Tag(name="T1", slug="t1")
    db.add(tag)
    await db.flush()

    now = datetime.now(UTC)

    # Create posts for Tag T1
    # TP0: Most recent for T1, not featured
    # TP1: Older for T1, featured (should be promoted in T1 archive)
    for i in range(5):
        p = Post(
            title=f"TP{i}", slug=f"tp{i}", content="C",
            status=PostStatus.PUBLISHED,
            is_featured=(i == 1),
            author_id=user.id,
            published_at=now - timedelta(days=i)
        )
        p.tags.append(tag)
        db.add(p)

    settings_service = SettingsService(db)
    await settings_service.update_setting("posts_per_page", 2)
    await db.commit()

    # Tag T1 Archive Page 1
    resp = await client.get("/tag/t1", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()

    assert len(data["posts"]) == 3
    assert data["posts"][0]["title"] == "TP1" # Promoted
    assert data["posts"][1]["title"] == "TP0"
    assert data["posts"][2]["title"] == "TP2"

    # Verify total count in response (if present)
    # The 'total' in tag_archive is used for display. 5 total posts.
    # Wait, let's check what tag_archive returns in JSON
    # tag_archive JSON: {"posts": [...], "pagination": {...}, "tag": {...}, "is_logged_in": ...}

    # Page 2: Should have TP3, TP4
    resp = await client.get("/tag/t1?page=2", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 2
    assert data["posts"][0]["title"] == "TP3"
    assert data["posts"][1]["title"] == "TP4"

@pytest.mark.asyncio
async def test_gallery_promotes_featured_post(client: AsyncClient, db: AsyncSession, test_user: dict):
    """Verify that gallery (tags page) promotes the latest featured post."""
    await db.execute(delete(Post))

    user = test_user["user"]
    now = datetime.now(UTC)

    # Create posts
    for i in range(5):
        p = Post(
            title=f"GP{i}", slug=f"gp{i}", content="C",
            status=PostStatus.PUBLISHED,
            is_featured=(i == 2), # GP2 is featured
            author_id=user.id,
            published_at=now - timedelta(days=i)
        )
        db.add(p)

    settings_service = SettingsService(db)
    await settings_service.update_setting("posts_per_page", 2)
    await db.commit()

    # Gallery Page 1
    resp = await client.get("/tags", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()

    assert len(data["posts"]) == 3
    assert data["posts"][0]["title"] == "GP2" # Promoted
    assert data["posts"][1]["title"] == "GP0"
    assert data["posts"][2]["title"] == "GP1"

    # Page 2: Should have GP3, GP4
    resp = await client.get("/tags?page=2", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 2
    assert data["posts"][0]["title"] == "GP3"
    assert data["posts"][1]["title"] == "GP4"

@pytest.mark.asyncio
async def test_no_featured_post_behavior(client: AsyncClient, db: AsyncSession, test_user: dict):
    """Verify normal pagination when no post is featured."""
    await db.execute(delete(Post))

    user = test_user["user"]
    now = datetime.now(UTC)

    for i in range(5):
        db.add(Post(
            title=f"NP{i}", slug=f"np{i}", content="C",
            status=PostStatus.PUBLISHED, is_featured=False,
            author_id=user.id, published_at=now - timedelta(days=i)
        ))

    settings_service = SettingsService(db)
    await settings_service.update_setting("posts_per_page", 2)
    await db.commit()

    # Page 1: Should have exactly 2 posts
    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    assert len(data["posts"]) == 2
    assert data["pagination"]["total_pages"] == 3 # 5 posts, 2 per page -> 3 pages

    assert data["posts"][0]["title"] == "NP0"
    assert data["posts"][1]["title"] == "NP1"
