"""Tests for tag archive pages."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_tag_page_loads(
    client: AsyncClient, sample_tag: Tag, published_post: Post
) -> None:
    """Test that tag archive page loads successfully."""
    response = await client.get(f"/tag/{sample_tag.slug}")
    assert response.status_code == 200
    assert sample_tag.name in response.text
    assert "text/html" in response.headers["content-type"]


@pytest.mark.asyncio
async def test_tag_page_shows_posts(
    client: AsyncClient, sample_tag: Tag, published_post: Post
) -> None:
    """Test that tag page shows posts with that tag."""
    response = await client.get(f"/tag/{sample_tag.slug}")
    assert response.status_code == 200
    assert published_post.title in response.text


@pytest.mark.asyncio
async def test_tag_page_shows_description(
    client: AsyncClient, sample_tag: Tag, published_post: Post
) -> None:
    """Test that tag page shows tag description."""
    response = await client.get(f"/tag/{sample_tag.slug}")
    assert response.status_code == 200
    assert sample_tag.description is not None
    assert sample_tag.description in response.text


@pytest.mark.asyncio
async def test_tag_not_found(client: AsyncClient) -> None:
    """Test that non-existent tag returns 404."""
    response = await client.get("/tag/non-existent-tag")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_tag_page_pagination(
    client: AsyncClient, sample_tag: Tag, multiple_posts: list[Post]
) -> None:
    """Test tag page pagination works."""
    response = await client.get(f"/tag/{sample_tag.slug}?page=2")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_tag_archive_ajax(client: AsyncClient, sample_tag: Tag) -> None:
    """Test tag archive AJAX request returns JSON."""
    response = await client.get(
        f"/tag/{sample_tag.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["tag"]["name"] == sample_tag.name


@pytest.mark.asyncio
async def test_tag_archive_hidden_404(client: AsyncClient, db: AsyncSession) -> None:
    """Test that hidden tags return 404 for anonymous users."""
    hidden_tag = Tag(name="Hidden Tag", slug="hidden-tag", is_hidden=True)
    db.add(hidden_tag)
    await db.commit()

    response = await client.get("/tag/hidden-tag")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_tag_archive_recursive_complex(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test recursive tag retrieval (grandparent/parent/child)."""
    user = test_user["user"]
    grandparent = Tag(name="Grandparent", slug="grandparent")
    parent = Tag(name="Parent", slug="parent")
    child = Tag(name="Child", slug="child")
    parent.parents = [grandparent]
    child.parents = [parent]
    db.add_all([grandparent, parent, child])

    post = Post(
        title="Deep Tagged Post",
        slug="deep-tagged-post",
        content="Deep",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    post.tags.append(child)
    db.add(post)
    await db.commit()

    response = await client.get("/tag/grandparent")
    assert response.status_code == 200
    assert "Deep Tagged Post" in response.text


@pytest.mark.asyncio
async def test_tag_archive_current_tag_not_in_featured(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test tag_archive when the current tag is not among the featured tags."""
    # Create a non-featured tag with a post
    tag = Tag(name="Hidden Gem", slug="hidden-gem", is_featured=False)
    db.add(tag)
    await db.flush()

    user = test_user["user"]
    post = Post(
        title="Hidden Gem Post",
        slug="hidden-gem-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    post.tags.append(tag)
    db.add(post)
    await db.commit()

    response = await client.get("/tag/hidden-gem")
    assert response.status_code == 200
    assert "Hidden Gem" in response.text


@pytest.mark.asyncio
async def test_tag_archive_current_tag_in_navigation(client: AsyncClient, sample_tag: Tag) -> None:
    """Test that the current tag is included in navigation context."""
    response = await client.get(f"/tag/{sample_tag.slug}")
    assert response.status_code == 200
    assert sample_tag.name in response.text
