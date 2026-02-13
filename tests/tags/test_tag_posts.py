"""Tests for tag-post relationships and post listing by tag."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.services.tag_service import TagService


@pytest.mark.asyncio
async def test_tag_post_ops_service(
    db: AsyncSession, service: TagService, test_user: dict
) -> None:
    """Test managing tags on a post via service layer."""
    post = Post(title="P", slug="p", content="C", author_id=test_user["user"].id)
    await post.awaitable_attrs.tags
    db.add(post)
    await db.commit()
    post = (
        await db.execute(select(Post).options(selectinload(Post.tags)))
    ).scalar_one()

    await service.add_tags_to_post(post, ["  ", "T1"])
    await service.add_tags_to_post(post, ["T1"])
    assert len(post.tags) == 1

    await service.set_post_tags(post, ["S1", "S2"])
    assert len(post.tags) == 2

    tid = post.tags[0].id
    await service.remove_tags_from_post(post, [tid])
    assert len(post.tags) == 1


@pytest.mark.asyncio
async def test_post_count_recalculation_service(
    db: AsyncSession, service: TagService
) -> None:
    """Test post count recalculation via service layer."""
    await service.update_post_count(9999)
    await service.update_post_counts_recursive([9999])

    t = Tag(name="T", slug="t")
    db.add(t)
    await db.commit()
    await service.update_post_count(t.id)
    await service.update_all_post_counts()


@pytest.mark.asyncio
async def test_get_posts_by_tag_service(
    db: AsyncSession, service: TagService, test_user: dict
) -> None:
    """Test retrieving posts by tag via service layer."""
    t = Tag(name="T", slug="t")
    db.add(t)
    await db.flush()
    p = Post(
        title="P",
        slug="p",
        content="C",
        author_id=test_user["user"].id,
        status=PostStatus.PUBLISHED,
    )
    (await p.awaitable_attrs.tags).append(t)

    db.add(p)
    await db.commit()
    await service.update_all_post_counts()

    await service.get_posts_by_tag(t.id, recursive=False)
    await service.get_posts_by_tag(t.id, public_only=True)
    await service.get_posts_by_tag(t.id, page=2, per_page=1)


@pytest.mark.asyncio
async def test_get_posts_by_tag_api(
    client: AsyncClient,
    sample_tag: Tag,
    published_post: Post,
    test_user: dict,
    db: AsyncSession,
) -> None:
    """Test GET /api/tags/{slug}/posts"""
    # Draft post
    draft = Post(
        title="D",
        slug="d",
        content="C",
        status=PostStatus.DRAFT,
        author_id=test_user["user"].id,
    )
    draft.tags.append(sample_tag)
    db.add(draft)
    await db.commit()

    # Public
    response = await client.get(f"/api/tags/{sample_tag.slug}/posts")
    assert response.status_code == 200
    data = response.json()
    assert any(p["slug"] == published_post.slug for p in data["posts"])
    assert all(p["slug"] != "d" for p in data["posts"])

    # Authenticated
    login_response = await client.post(
        "/api/auth/login",
        json={"username": test_user["username"], "name": test_user["password"]},
    )
    cookies = dict(login_response.cookies)
    response = await client.get(f"/api/tags/{sample_tag.slug}/posts", cookies=cookies)
    assert any(p["slug"] == "d" for p in response.json()["posts"])

    # Not found
    response = await client.get("/api/tags/none/posts")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_recalculate_counts_api(
    client: AsyncClient, auth_cookies: dict[str, str]
) -> None:
    """Test POST /api/tags/recalculate-counts"""
    response = await client.post("/api/tags/recalculate-counts", cookies=auth_cookies)
    assert response.status_code == 200

    # Unauthorized
    client.cookies.clear()
    response = await client.post("/api/tags/recalculate-counts")
    assert response.status_code == 401
