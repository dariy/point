"""Tests for homepage functionality."""

from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_homepage_loads(client: AsyncClient) -> None:
    """Test that homepage loads successfully."""
    response = await client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


@pytest.mark.asyncio
async def test_homepage_shows_no_posts_message(client: AsyncClient) -> None:
    """Test homepage shows empty state when no posts exist."""
    response = await client.get("/")
    assert response.status_code == 200
    assert "No posts yet" in response.text


@pytest.mark.asyncio
async def test_homepage_shows_published_posts(
    client: AsyncClient, published_post: Post
) -> None:
    """Test homepage displays published posts."""
    response = await client.get("/")
    assert response.status_code == 200
    assert published_post.title in response.text


@pytest.mark.asyncio
async def test_homepage_hides_draft_posts(
    client: AsyncClient, draft_post: Post
) -> None:
    """Test homepage does not show draft posts."""
    response = await client.get("/")
    assert response.status_code == 200
    assert draft_post.title not in response.text


@pytest.mark.asyncio
async def test_homepage_pagination(
    client: AsyncClient, multiple_posts: list[Post]
) -> None:
    """Test homepage pagination works."""
    # First page
    response = await client.get("/")
    assert response.status_code == 200
    assert "Test Post 1" in response.text

    # Second page
    response = await client.get("/?page=2")
    assert response.status_code == 200
    assert "Test Post 11" in response.text


@pytest.mark.asyncio
async def test_homepage_ajax_json(client: AsyncClient) -> None:
    """Test homepage AJAX request returns JSON."""
    response = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    data = response.json()
    assert "posts" in data
    assert "pagination" in data


@pytest.mark.asyncio
async def test_homepage_ajax_authenticated(client: AsyncClient, auth_cookies: dict, published_post: Post) -> None:
    """Test homepage AJAX request when authenticated."""
    response = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"}, cookies=auth_cookies)
    assert response.status_code == 200
    data = response.json()
    assert data["is_logged_in"] is True
    assert len(data["posts"]) > 0


@pytest.mark.asyncio
async def test_homepage_with_featured_posts(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test homepage with featured posts."""
    user = test_user["user"]
    post = Post(
        title="Featured Post",
        slug="featured-post",
        content="Featured content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
        is_featured=True
    )
    db.add(post)
    await db.commit()
    response = await client.get("/")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_homepage_with_hidden_posts(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test homepage filtering out posts with hidden tags."""
    user = test_user["user"]
    hidden_tag = Tag(name="Hidden Posts", slug="hidden-posts", is_hidden_posts=True)
    db.add(hidden_tag)
    await db.commit()

    hidden_post = Post(
        title="Hidden Post",
        slug="hidden-post",
        content="Secret content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    hidden_post.tags.append(hidden_tag)
    db.add(hidden_post)
    await db.commit()

    # Request as anonymous user
    response = await client.get("/")
    assert response.status_code == 200
    assert "Hidden Post" not in response.text


@pytest.mark.asyncio
async def test_homepage_with_empty_hidden_posts_tags(client: AsyncClient) -> None:
    """Test homepage logic when hidden_posts_tag_ids is empty."""
    with patch("app.services.tag_service.TagService.get_hidden_posts_tag_ids") as mock_get:
        mock_get.return_value = []
        response = await client.get("/")
        assert response.status_code == 200


@pytest.mark.asyncio
async def test_homepage_filter_hidden_tags_complex(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test homepage filtering of hidden tags for non-authenticated users."""
    user = test_user["user"]

    # Create public tag and hidden tag
    public_tag = Tag(name="Public Tag", slug="public-tag")
    hidden_tag = Tag(name="Hidden Tag", slug="hidden-tag", is_hidden=True)
    db.add_all([public_tag, hidden_tag])
    await db.flush()

    # Create post with both tags
    post = Post(
        title="Mixed Tags Post",
        slug="mixed-tags-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    post.tags.extend([public_tag, hidden_tag])
    db.add(post)
    await db.commit()

    # Non-authenticated request
    response = await client.get("/")
    assert response.status_code == 200
    # Should see public tag, but not hidden tag
    assert "public-tag" in response.text
    assert "hidden-tag" not in response.text


@pytest.mark.asyncio
async def test_homepage_pagination_invalid_page_number(client: AsyncClient) -> None:
    """Test homepage with invalid page number."""
    response = await client.get("/?page=abc")
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_homepage_html_has_ajax_class(client: AsyncClient, multiple_posts: list[Post]) -> None:
    """Test homepage HTML contains necessary markers for AJAX navigation."""
    response = await client.get("/")
    assert 'class="posts-main"' in response.text
    assert 'class="pagination"' in response.text
