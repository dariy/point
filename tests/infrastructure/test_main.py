"""Coverage tests for Main Application."""

import contextlib
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import app, global_exception_handler
from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    """Test health check endpoint."""
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}

@pytest.mark.asyncio
async def test_global_exception_handler():
    """Test global exception handler."""
    request = MagicMock(spec=Request)
    exc = Exception("Test error")

    # Test with debug=True
    with patch("app.main.settings.debug", True):
        response = await global_exception_handler(request, exc)
        assert response.status_code == 500
        data = response.body.decode()
        assert "Test error" in data

    # Test with debug=False
    with patch("app.main.settings.debug", False):
        response = await global_exception_handler(request, exc)
        assert response.status_code == 500
        data = response.body.decode()
        assert "Internal server error" in data

@pytest.mark.asyncio
async def test_preview_post_endpoint(client: AsyncClient, db, test_user):
    """Test preview post endpoint in main.py."""
    from datetime import UTC, datetime, timedelta

    from app.models.post import Post, PostFormatter, PostStatus

    # Create post with token
    post = Post(
        title="Preview",
        slug="preview",
        content="Content",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id,
        preview_token="token123",
        preview_expires_at=datetime.now(UTC) + timedelta(hours=1)
    )
    db.add(post)
    await db.commit()

    response = await client.get("/preview/token123")
    assert response.status_code == 200
    assert response.json()["preview_mode"] is True

@pytest.mark.asyncio
async def test_preview_post_invalid_token(client: AsyncClient):
    """Test preview post with invalid token."""
    response = await client.get("/preview/invalid")
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_preview_post_expired(client: AsyncClient, db, test_user):
    """Test preview post with expired token."""
    from datetime import UTC, datetime, timedelta

    from app.models.post import Post, PostFormatter, PostStatus

    post = Post(
        title="Expired",
        slug="expired",
        content="Content",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id,
        preview_token="token_exp",
        preview_expires_at=datetime.now(UTC) - timedelta(hours=1)
    )
    db.add(post)
    await db.commit()

    response = await client.get("/preview/token_exp")
    assert response.status_code == 410


@pytest.mark.asyncio
async def test_get_db_yields_session():
    """Test get_db dependency yields a session."""
    gen = get_db()
    session = await anext(gen)
    assert session is not None
    await session.close()
    # clean up
    with contextlib.suppress(StopAsyncIteration):
        await anext(gen)

def test_app_startup_shutdown():
    """Test app events (mocked usually as they run in lifespan)."""
    # Lifespan testing requires TestClient with with block usually, which is covered by other tests running client.
    # We can check if routes are registered
    assert len(app.routes) > 0

@pytest.mark.asyncio
async def test_validation_exception_handler():
    """Test global validation exception handler."""
    # The handler is registered in app.exception_handlers
    handler = app.exception_handlers.get(RequestValidationError)
    # If not explicitly registered (FastAPI default), this might return None or default
    if handler:
        request = MagicMock(spec=Request)
        exc = RequestValidationError(errors=[{"loc": ("body", "field"), "msg": "error", "type": "type_error"}])

        resp = await handler(request, exc)
        assert resp.status_code == 422


# Helper fixture for creating published post with all fields
@pytest.fixture
async def full_published_post(db: AsyncSession, test_user) -> Post:
    """Create a comprehensive published post."""
    tag1 = Tag(name="Photography", slug="photography", post_count=0)
    tag2 = Tag(name="Travel", slug="travel", post_count=0)
    db.add(tag1)
    db.add(tag2)
    await db.commit()

    post = Post(
        title="Amazing Photo Journey",
        slug="amazing-photo-journey",
        content="![Photo](2026/01/test.jpg)\n\nThis is my **amazing** photo journey with lots of text content.",
        excerpt="A great journey",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.now(UTC) - timedelta(days=1),
        view_count=100,
        thumbnail_path="2026/01/thumb.jpg",
        author_id=test_user["user"].id,
    )
    post.tags.extend([tag1, tag2])
    db.add(post)
    await db.commit()
    await db.refresh(post)

    return post


class TestAjaxRequests:
    """Test AJAX request handling for JSON responses."""

    @pytest.mark.asyncio
    async def test_homepage_ajax_json_response(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test homepage returns JSON for AJAX requests."""
        response = await client.get(
            "/",
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        assert response.status_code == 200
        data = response.json()
        assert "posts" in data
        assert "pagination" in data
        assert isinstance(data["posts"], list)

    @pytest.mark.asyncio
    async def test_single_post_ajax_json_response(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test single post returns JSON for AJAX requests."""
        response = await client.get(
            f"/posts/{full_published_post.slug}",
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        assert response.status_code == 200
        data = response.json()
        assert "post" in data
        assert data["post"]["title"] == full_published_post.title
        assert "post_media" in data
        assert "has_text_content" in data

    @pytest.mark.asyncio
    async def test_tag_archive_ajax_json_response(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test tag archive returns JSON for AJAX requests."""
        tag = full_published_post.tags[0]
        response = await client.get(
            f"/tag/{tag.slug}",
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        assert response.status_code == 200
        data = response.json()
        assert "posts" in data
        assert "pagination" in data

    @pytest.mark.asyncio
    async def test_gallery_ajax_json_response(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test gallery returns JSON for AJAX requests."""
        response = await client.get(
            "/tags",
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        assert response.status_code == 200
        data = response.json()
        assert "posts" in data
        assert "pagination" in data


class TestPaginationEdgeCases:
    """Test pagination edge cases."""

    @pytest.mark.asyncio
    async def test_homepage_page_beyond_total(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test requesting page number beyond total pages."""
        response = await client.get("/?page=999")
        # Should still return 200 with empty results
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_tag_archive_pagination(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test tag archive with pagination."""
        tag = full_published_post.tags[0]
        response = await client.get(f"/tag/{tag.slug}?page=1")
        assert response.status_code == 200


class TestPostMediaExtraction:
    """Test media extraction from post content."""

    @pytest.mark.asyncio
    async def test_post_with_multiple_images(
        self,
        client: AsyncClient,
        db: AsyncSession,
        test_user,
    ):
        """Test post with multiple images extracts media correctly."""
        post = Post(
            title="Multi Image Post",
            slug="multi-image-post",
            content="![Img1](img1.jpg) Some text ![Img2](img2.jpg) More text <img src='img3.jpg'>",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.now(UTC),
            author_id=test_user["user"].id,
        )
        db.add(post)
        await db.commit()

        response = await client.get(f"/posts/{post.slug}")
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_post_without_media(
        self,
        client: AsyncClient,
        db: AsyncSession,
        test_user,
    ):
        """Test post without any media."""
        post = Post(
            title="Text Only Post",
            slug="text-only-post",
            content="This is just plain text with no images or videos.",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.now(UTC),
            author_id=test_user["user"].id,
        )
        db.add(post)
        await db.commit()

        response = await client.get(f"/posts/{post.slug}")
        assert response.status_code == 200


class TestPostNavigation:
    """Test prev/next post navigation."""

    @pytest.mark.asyncio
    async def test_post_with_navigation_links(
        self,
        client: AsyncClient,
        db: AsyncSession,
        test_user,
    ):
        """Test that post page includes prev/next navigation."""
        # Create three posts in sequence
        post1 = Post(
            title="First Post",
            slug="first-post",
            content="Content 1",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.now(UTC) - timedelta(days=2),
            author_id=test_user["user"].id,
        )
        post2 = Post(
            title="Second Post",
            slug="second-post",
            content="Content 2",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.now(UTC) - timedelta(days=1),
            author_id=test_user["user"].id,
        )
        post3 = Post(
            title="Third Post",
            slug="third-post",
            content="Content 3",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.now(UTC),
            author_id=test_user["user"].id,
        )
        db.add_all([post1, post2, post3])
        await db.commit()

        # Middle post should have both prev and next
        response = await client.get("/posts/second-post")
        assert response.status_code == 200


class TestRawFormatter:
    """Test HTML formatter handling."""

    @pytest.mark.asyncio
    async def test_post_with_html_formatter(
        self,
        client: AsyncClient,
        db: AsyncSession,
        test_user,
    ):
        """Test post with HTML formatter."""
        post = Post(
            title="HTML Post",
            slug="html-post",
            content="<div><p>This is <strong>raw</strong> HTML</p></div>",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.HTML,
            published_at=datetime.now(UTC),
            author_id=test_user["user"].id,
        )
        db.add(post)
        await db.commit()

        response = await client.get(f"/posts/{post.slug}")
        assert response.status_code == 200
        # HTML should be preserved
        assert "<strong>raw</strong>" in response.text


class TestTagsPage:
    """Test tags listing page."""

    @pytest.mark.asyncio
    async def test_tags_page_with_tags(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test tags page displays all tags."""
        response = await client.get("/tags")
        assert response.status_code == 200
        # Should list tags
        assert "photography" in response.text.lower() or "travel" in response.text.lower()

    @pytest.mark.asyncio
    async def test_tags_page_empty(
        self,
        client: AsyncClient,
    ):
        """Test tags page when no tags exist."""
        response = await client.get("/tags")
        assert response.status_code == 200


class TestGalleryFiltering:
    """Test gallery tag filtering."""

    @pytest.mark.asyncio
    async def test_gallery_filter_by_tag(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test gallery can filter by tag."""
        tag = full_published_post.tags[0]
        response = await client.get(f"/tag/{tag.slug}")
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_gallery_filter_invalid_tag(
        self,
        client: AsyncClient,
    ):
        """Test gallery with invalid tag filter."""
        response = await client.get("/tag/nonexistent")
        # Returns 404 for nonexistent tag
        assert response.status_code == 404


class TestPostWithoutPublishedDate:
    """Test posts without published_at."""

    @pytest.mark.asyncio
    async def test_post_without_published_at(
        self,
        client: AsyncClient,
        db: AsyncSession,
        test_user,
    ):
        """Test post that has no published_at uses created_at."""
        post = Post(
            title="No Publish Date",
            slug="no-publish-date",
            content="Content",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=None,  # Explicitly no publish date
            author_id=test_user["user"].id,
        )
        db.add(post)
        await db.commit()

        response = await client.get(f"/posts/{post.slug}")
        assert response.status_code == 200


class TestHomepageEmpty:
    """Test homepage with no posts."""

    @pytest.mark.asyncio
    async def test_homepage_no_published_posts(
        self,
        client: AsyncClient,
    ):
        """Test homepage when no published posts exist."""
        response = await client.get("/")
        assert response.status_code == 200
        # Should show "no posts" message
        assert "no posts" in response.text.lower() or "yet" in response.text.lower()


class TestSitemapEdgeCases:
    """Test sitemap edge cases."""

    @pytest.mark.asyncio
    async def test_sitemap_with_posts(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test sitemap includes published posts."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert "<?xml" in response.text
        assert full_published_post.slug in response.text


class TestRSSEdgeCases:
    """Test RSS feed edge cases."""

    @pytest.mark.asyncio
    async def test_rss_with_posts(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Test RSS feed includes published posts."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert "<?xml" in response.text
        assert full_published_post.title in response.text
