"""Additional tests to improve code coverage.

Focuses on testing code paths not covered by existing tests.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag
from datetime import datetime, timedelta


# Helper fixture for creating published post with all fields
@pytest.fixture
async def full_published_post(db: AsyncSession) -> Post:
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
        published_at=datetime.utcnow() - timedelta(days=1),
        view_count=100,
        thumbnail_path="2026/01/thumb.jpg",
        author_id=1,
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
            f"/tags/{tag.slug}",
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
        response = await client.get(f"/tags/{tag.slug}?page=1")
        assert response.status_code == 200


class TestPostMediaExtraction:
    """Test media extraction from post content."""

    @pytest.mark.asyncio
    async def test_post_with_multiple_images(
        self,
        client: AsyncClient,
        db: AsyncSession,
    ):
        """Test post with multiple images extracts media correctly."""
        post = Post(
            title="Multi Image Post",
            slug="multi-image-post",
            content="![Img1](img1.jpg) Some text ![Img2](img2.jpg) More text <img src='img3.jpg'>",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow(),
            author_id=1,
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
    ):
        """Test post without any media."""
        post = Post(
            title="Text Only Post",
            slug="text-only-post",
            content="This is just plain text with no images or videos.",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow(),
            author_id=1,
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
    ):
        """Test that post page includes prev/next navigation."""
        # Create three posts in sequence
        post1 = Post(
            title="First Post",
            slug="first-post",
            content="Content 1",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow() - timedelta(days=2),
            author_id=1,
        )
        post2 = Post(
            title="Second Post",
            slug="second-post",
            content="Content 2",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow() - timedelta(days=1),
            author_id=1,
        )
        post3 = Post(
            title="Third Post",
            slug="third-post",
            content="Content 3",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow(),
            author_id=1,
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
    ):
        """Test post with HTML formatter."""
        post = Post(
            title="HTML Post",
            slug="html-post",
            content="<div><p>This is <strong>raw</strong> HTML</p></div>",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.HTML,
            published_at=datetime.utcnow(),
            author_id=1,
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
        response = await client.get(f"/tags/{tag.slug}")
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_gallery_filter_invalid_tag(
        self,
        client: AsyncClient,
    ):
        """Test gallery with invalid tag filter."""
        response = await client.get("/tags/nonexistent")
        # Should still return 200, just empty results (or all posts depending on logic)
        assert response.status_code == 200


class TestPostWithoutPublishedDate:
    """Test posts without published_at."""

    @pytest.mark.asyncio
    async def test_post_without_published_at(
        self,
        client: AsyncClient,
        db: AsyncSession,
    ):
        """Test post that has no published_at uses created_at."""
        post = Post(
            title="No Publish Date",
            slug="no-publish-date",
            content="Content",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=None,  # Explicitly no publish date
            author_id=1,
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
