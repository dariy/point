import pytest
from datetime import datetime
from app.models.post import Post, PostStatus, PostFormatter

@pytest.mark.asyncio
async def test_single_post_ajax(client, db, test_user):
    """Test fetching a single post via AJAX returns JSON."""
    # Create a post
    post = Post(
        title="AJAX Test Post",
        slug="ajax-test-post",
        content="<p>Test Content</p>",
        status=PostStatus.PUBLISHED,
        published_at=datetime.utcnow(),
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id
    )
    db.add(post)
    await db.commit()

    # Request with AJAX header
    response = await client.get(
        f"/posts/{post.slug}",
        headers={"X-Requested-With": "XMLHttpRequest"}
    )

    assert response.status_code == 200
    assert "application/json" in response.headers["content-type"]

    data = response.json()

    # Verify structure
    assert "post" in data
    assert data["post"]["title"] == "AJAX Test Post"
    assert data["post"]["slug"] == "ajax-test-post"
    assert "content_html" in data["post"]

    assert "has_text_content" in data
    assert data["has_text_content"] is True

    assert "post_media" in data
    assert isinstance(data["post_media"], list)

    assert "blog_settings" in data
    assert "blog_title" in data

@pytest.mark.asyncio
async def test_single_post_immersive_ajax(client, db, test_user):
    """Test fetching a media-only post via AJAX returns JSON with correct flags."""
    # Create a post with only image, no text
    post = Post(
        title="Immersive Post",
        slug="immersive-post",
        content="![Image](test.jpg)",
        status=PostStatus.PUBLISHED,
        published_at=datetime.utcnow(),
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id
    )
    db.add(post)
    await db.commit()

    # Request with AJAX header
    response = await client.get(
        f"/posts/{post.slug}",
        headers={"X-Requested-With": "XMLHttpRequest"}
    )

    assert response.status_code == 200
    data = response.json()

    # has_text_content should be False (or True if my formatter logic considers the image tag as content,
    # but the logic uses strip_html to check for text)
    # The format_content utility converts markdown to HTML.
    # strip_html removes tags.
    # "![Image](test.jpg)" -> <img src...> -> strip_html -> "" -> False.

    # Wait, format_content might wrap it in <p>?
    # If it is just an image, markdown might wrap in <p>.
    # <p><img ...></p> -> strip_html -> "" (empty).

    # Let's verify expectations based on implementation.
    # If implementation is correct, has_text_content should be False.

    assert data["post"]["title"] == "Immersive Post"
    # Note: Depending on implementation details of strip_html and formatters,
    # this might be tricky, but let's assume standard behavior.
    assert data["has_text_content"] is False
    assert len(data["post_media"]) > 0
"""Tests for AJAX pagination."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta

from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag

@pytest.fixture
async def sample_posts(db: AsyncSession) -> list[Post]:
    """Create sample posts."""
    posts = []
    for i in range(15):
        post = Post(
            title=f"Test Post {i}",
            slug=f"test-post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow() - timedelta(hours=i),
            author_id=1,
        )
        db.add(post)
        posts.append(post)
    await db.commit()
    return posts

@pytest.fixture
async def sample_tag_with_posts(db: AsyncSession) -> Tag:
    """Create a tag and attach to posts."""
    tag = Tag(name="Ajax Tag", slug="ajax-tag", post_count=0)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)

    for i in range(15):
        post = Post(
            title=f"Tagged Post {i}",
            slug=f"tagged-post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow() - timedelta(hours=i),
            author_id=1,
        )
        post.tags.append(tag)
        db.add(post)

    tag.post_count = 15
    await db.commit()
    return tag

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
async def test_tag_archive_ajax_pagination(client: AsyncClient, sample_tag_with_posts: Tag):
    """Test tag archive returns JSON for AJAX requests."""
    response = await client.get(f"/tag/{sample_tag_with_posts.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"

    data = response.json()
    assert "posts" in data
    assert "pagination" in data
    assert "tag" in data
    assert data["tag"]["slug"] == sample_tag_with_posts.slug

@pytest.mark.asyncio
async def test_homepage_html_has_ajax_class(client: AsyncClient, sample_posts: list[Post]):
    """Test homepage HTML pagination links have ajax-link class."""
    # Request page 1, ensure multiple pages (default limit 10, posts 15)
    response = await client.get("/")
    assert response.status_code == 200
    # Pagination should be present
    assert "pagination-link" in response.text
    # ajax-link should be present
    assert "ajax-link" in response.text

@pytest.mark.asyncio
async def test_tag_archive_html_has_ajax_class(client: AsyncClient, sample_tag_with_posts: Tag):
    """Test tag archive HTML pagination links have ajax-link class."""
    response = await client.get(f"/tag/{sample_tag_with_posts.slug}")
    assert response.status_code == 200
    assert "pagination-link" in response.text
    assert "ajax-link" in response.text
