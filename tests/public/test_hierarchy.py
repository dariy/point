"""Tests for hierarchical tags functionality in public views."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_post_detail_includes_parents(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test that post detail includes parent tags via AJAX."""
    user = test_user["user"]
    parent = Tag(name="Parent Tag", slug="parent-tag")
    child = Tag(name="Child Tag", slug="child-tag")
    child.parents = [parent]
    db.add_all([parent, child])

    post = Post(
        title="Hierarchical Post",
        slug="hierarchical-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    post.tags.append(child)
    db.add(post)
    await db.commit()

    # Check AJAX response which includes serialized tags
    response = await client.get(f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    data = response.json()

    # Tags are included in the 'post' object
    tag_names = [t["name"] for t in data["post"]["tags"]]
    assert "Child Tag" in tag_names


@pytest.mark.asyncio
async def test_tags_page_with_hierarchical_tags_regression(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Regression test for hierarchical tags rendering in tags gallery.
    Tags must have post_count > 0 to appear.
    """
    user = test_user["user"]
    grandparent = Tag(name="Grandparent Tag", slug="grandparent-tag", post_count=1)
    parent = Tag(name="Parent Tag", slug="parent-tag", post_count=1)
    child = Tag(name="Child Tag", slug="child-tag", post_count=1)
    parent.parents = [grandparent]
    child.parents = [parent]
    db.add_all([grandparent, parent, child])

    post = Post(
        title="Deep Hierarchy",
        slug="deep-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    # Tag with all to ensure they all show up (post_count > 0 check in tags_page)
    post.tags.extend([grandparent, parent, child])
    db.add(post)
    await db.commit()

    # Hierarchical tags appear in the tags gallery
    response = await client.get("/tags")
    assert response.status_code == 200
    # They should be in the tag groups
    assert "Grandparent Tag" in response.text
    assert "Parent Tag" in response.text
    assert "Child Tag" in response.text
