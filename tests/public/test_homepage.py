"""Tests for homepage functionality."""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.models.user import User


@pytest.mark.asyncio
async def test_homepage_pagination_invalid_page_number(
    client: AsyncClient, db: AsyncSession
):
    """Test homepage with invalid page numbers."""
    # Create a test user and post
    user = User(
        username="testuser",
        email="test@test.com",
        password_hash="hash",
        display_name="Test",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="Test",
        slug="test",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
    )
    db.add(post)
    await db.commit()

    # Test page=0 (should handle gracefully)
    resp = await client.get("/?page=0")
    assert resp.status_code == 200

    # Test negative page
    resp = await client.get("/?page=-1")
    assert resp.status_code == 200

    # Test very large page number (beyond total pages)
    resp = await client.get("/?page=999")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_homepage_ajax_structure(client: AsyncClient, db: AsyncSession):
    """Test full structure of homepage AJAX response."""
    user = User(
        username="ajaxhome",
        email="ajaxhome@test.com",
        password_hash="hash",
        display_name="AJAX Home",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="Home AJAX Post",
        slug="home-ajax-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
    )
    db.add(post)
    await db.commit()

    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    assert "posts" in data
    assert len(data["posts"]) > 0
    assert "pagination" in data
    assert "is_logged_in" in data

    # Check pagination structure
    pagination = data["pagination"]
    assert "page" in pagination
    assert "total_pages" in pagination
    assert "has_next" in pagination
    assert "has_prev" in pagination
    assert "next_page" in pagination
    assert "prev_page" in pagination


@pytest.fixture
async def sample_posts(db: AsyncSession, test_user) -> list[Post]:
    """Create sample posts for pagination tests."""
    posts = []
    for i in range(15):
        post = Post(
            title=f"Test Post {i}",
            slug=f"test-post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.now(UTC) - timedelta(hours=i),
            author_id=test_user["user"].id,
        )
        db.add(post)
        posts.append(post)
    await db.commit()
    return posts


@pytest.mark.asyncio
async def test_homepage_ajax_pagination(client: AsyncClient, sample_posts: list[Post]):
    """Test homepage returns JSON for AJAX requests."""
    response = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"

    data = response.json()
    assert "posts" in data
    assert "pagination" in data
    assert len(data["posts"]) > 0
    assert data["pagination"]["page"] == 1

    # Check post structure
    post = data["posts"][0]
    assert "title" in post
    assert "slug" in post
    assert "preview_html" in post or "excerpt" in post


@pytest.mark.asyncio
async def test_homepage_html_has_ajax_class(
    client: AsyncClient, sample_posts: list[Post]
):
    """Test homepage HTML pagination links have ajax-link class."""
    # Request page 1, ensure multiple pages (default limit 10, posts 15)
    response = await client.get("/")
    assert response.status_code == 200
    # Pagination should be present
    assert "pagination-link" in response.text
    # ajax-link should be present
    assert "ajax-link" in response.text
