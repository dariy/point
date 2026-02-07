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

    # Verify post_tags_with_parents in response
    assert "post_tags_with_parents" in data
    tags_with_parents = data["post_tags_with_parents"]

    # Find Category X
    cat_entry = next((t for t in tags_with_parents if t["tag"]["name"] == "Category X"), None)
    assert cat_entry is not None
    assert len(cat_entry["children"]) == 1
    assert cat_entry["children"][0]["name"] == "Subtag Y"

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
    tags_with_parents = data["post_tags_with_parents"]

    # Should appear under both P1 and P2
    p1_entry = next((t for t in tags_with_parents if t["tag"]["name"] == "P1"), None)
    p2_entry = next((t for t in tags_with_parents if t["tag"]["name"] == "P2"), None)

    assert p1_entry is not None
    assert p2_entry is not None
    assert any(child["name"] == "C" for child in p1_entry["children"])
    assert any(child["name"] == "C" for child in p2_entry["children"])
