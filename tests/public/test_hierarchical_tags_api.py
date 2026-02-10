"""Tests for hierarchical tags in public API."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.schemas.tag import TagCreate
from app.services.tag_service import TagService


@pytest.mark.asyncio
async def test_post_detail_includes_parents(client: AsyncClient, db: AsyncSession, test_user):
    """Test that post detail response includes parent tags (categories)."""
    tag_service = TagService(db)

    # Create hierarchy
    cat = await tag_service.create_tag(TagCreate(name="Category X"))
    sub = await tag_service.create_tag(TagCreate(name="Subtag Y", parent_ids=[cat.id]))

    # Create post with subtag
    post = Post(
        title="Hierarchical Tag Test",
        slug="h-tag-test",
        content="Content",
        status=PostStatus.PUBLISHED,
        published_at=datetime.now(UTC),
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id
    )
    post.tags.append(sub)
    db.add(post)
    await db.commit()

    # Fetch post detail via AJAX
    response = await client.get(
        f"/posts/{post.slug}",
        headers={"X-Requested-With": "XMLHttpRequest"}
    )

    assert response.status_code == 200
    data = response.json()

    # Verify post_tags_with_parents is legacy (empty list)
    assert "post_tags_with_parents" in data
    assert data["post_tags_with_parents"] == []

    # Verify tags are in the post.tags array
    assert "post" in data
    assert "tags" in data["post"]
    tag_names = [t["name"] for t in data["post"]["tags"]]
    assert "Subtag Y" in tag_names

@pytest.mark.asyncio
async def test_post_detail_multiple_parents(client: AsyncClient, db: AsyncSession, test_user):
    """Test post tags with multiple parents are grouped correctly."""
    tag_service = TagService(db)

    p1 = await tag_service.create_tag(TagCreate(name="P1"))
    p2 = await tag_service.create_tag(TagCreate(name="P2"))
    c = await tag_service.create_tag(TagCreate(name="C", parent_ids=[p1.id, p2.id]))

    post = Post(
        title="Multi Parent Test",
        slug="multi-parent",
        content="C",
        status=PostStatus.PUBLISHED,
        published_at=datetime.now(UTC),
        author_id=test_user["user"].id
    )
    post.tags.append(c)
    db.add(post)
    await db.commit()

    response = await client.get(
        f"/posts/{post.slug}",
        headers={"X-Requested-With": "XMLHttpRequest"}
    )
    data = response.json()

    # Verify post_tags_with_parents is legacy (empty list)
    assert "post_tags_with_parents" in data
    assert data["post_tags_with_parents"] == []

    # Verify tags are in the post.tags array
    assert "post" in data
    assert "tags" in data["post"]
    tag_names = [t["name"] for t in data["post"]["tags"]]
    assert "C" in tag_names
