"""Tests for public frontend routes.

Tests the public-facing HTML pages: homepage, single post, tag archive, and gallery.
"""

from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag


@pytest.fixture
async def sample_tag(db: AsyncSession) -> Tag:
    """Create a sample tag for testing.

    Args:
        db: Database session

    Returns:
        Created tag
    """
    tag = Tag(
        name="Test Tag",
        slug="test-tag",
        description="A test tag for testing",
        is_important=True,
        post_count=0,
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag


@pytest.fixture
async def published_post(db: AsyncSession, sample_tag: Tag) -> Post:
    """Create a published post for testing.

    Args:
        db: Database session
        sample_tag: Tag to attach

    Returns:
        Created post
    """
    post = Post(
        title="Test Published Post",
        slug="test-published-post",
        content="This is test content for the published post.",
        excerpt="Test excerpt",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.utcnow() - timedelta(hours=1),
        view_count=10,
        thumbnail_path="2026/01/test-image.jpg",
        author_id=1,
    )
    post.tags.append(sample_tag)
    db.add(post)
    await db.commit()
    await db.refresh(post)

    # Update tag post count
    sample_tag.post_count = 1
    await db.commit()

    return post


@pytest.fixture
async def draft_post(db: AsyncSession) -> Post:
    """Create a draft post for testing.

    Args:
        db: Database session

    Returns:
        Created draft post
    """
    post = Post(
        title="Test Draft Post",
        slug="test-draft-post",
        content="This is a draft post.",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=1,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post


@pytest.fixture
async def multiple_posts(db: AsyncSession, sample_tag: Tag) -> list[Post]:
    """Create multiple published posts for testing.

    Args:
        db: Database session
        sample_tag: Tag to attach

    Returns:
        List of created posts
    """
    posts = []
    for i in range(15):
        post = Post(
            title=f"Test Post {i + 1}",
            slug=f"test-post-{i + 1}",
            content=f"Content for post {i + 1}",
            excerpt=f"Excerpt for post {i + 1}",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow() - timedelta(hours=i),
            view_count=i * 5,
            thumbnail_path=f"2026/01/image-{i + 1}.jpg" if i % 2 == 0 else None,
            author_id=1,
        )
        if i < 5:
            post.tags.append(sample_tag)
        posts.append(post)
        db.add(post)

    await db.commit()

    # Update tag count
    sample_tag.post_count = 5
    await db.commit()

    return posts


class TestHomepage:
    """Tests for the homepage."""

    @pytest.mark.asyncio
    async def test_homepage_loads(self, client: AsyncClient) -> None:
        """Test that homepage loads successfully."""
        response = await client.get("/")
        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_homepage_shows_no_posts_message(
        self, client: AsyncClient
    ) -> None:
        """Test homepage shows empty state when no posts exist."""
        response = await client.get("/")
        assert response.status_code == 200
        assert "No posts yet" in response.text

    @pytest.mark.asyncio
    async def test_homepage_shows_published_posts(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test homepage displays published posts."""
        response = await client.get("/")
        assert response.status_code == 200
        assert published_post.title in response.text

    @pytest.mark.asyncio
    async def test_homepage_hides_draft_posts(
        self, client: AsyncClient, draft_post: Post
    ) -> None:
        """Test homepage does not show draft posts."""
        response = await client.get("/")
        assert response.status_code == 200
        assert draft_post.title not in response.text

    @pytest.mark.asyncio
    async def test_homepage_pagination(
        self, client: AsyncClient, multiple_posts: list[Post]
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


class TestSinglePost:
    """Tests for single post view."""

    @pytest.mark.asyncio
    async def test_post_page_loads(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that a published post page loads successfully."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert published_post.title in response.text
        assert "text/html" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_post_page_shows_content(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that post page displays content."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert published_post.content in response.text

    @pytest.mark.asyncio
    async def test_post_page_shows_tags(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that post page displays tags."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert "Test Tag" in response.text

    @pytest.mark.asyncio
    async def test_post_not_found(self, client: AsyncClient) -> None:
        """Test that non-existent post returns 404."""
        response = await client.get("/posts/non-existent-slug")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_draft_post_not_accessible(
        self, client: AsyncClient, draft_post: Post
    ) -> None:
        """Test that draft posts are not publicly accessible."""
        response = await client.get(f"/posts/{draft_post.slug}")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_view_count_increments(
        self, client: AsyncClient, published_post: Post, db: AsyncSession
    ) -> None:
        """Test that viewing a post increments view count."""
        initial_count = published_post.view_count

        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200

        await db.refresh(published_post)
        assert published_post.view_count == initial_count + 1


class TestTagArchive:
    """Tests for tag archive pages."""

    @pytest.mark.asyncio
    async def test_tag_page_loads(
        self, client: AsyncClient, sample_tag: Tag, published_post: Post
    ) -> None:
        """Test that tag archive page loads successfully."""
        response = await client.get(f"/tag/{sample_tag.slug}")
        assert response.status_code == 200
        assert sample_tag.name in response.text
        assert "text/html" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_tag_page_shows_posts(
        self, client: AsyncClient, sample_tag: Tag, published_post: Post
    ) -> None:
        """Test that tag page shows posts with that tag."""
        response = await client.get(f"/tag/{sample_tag.slug}")
        assert response.status_code == 200
        assert published_post.title in response.text

    @pytest.mark.asyncio
    async def test_tag_page_shows_description(
        self, client: AsyncClient, sample_tag: Tag, published_post: Post
    ) -> None:
        """Test that tag page shows tag description."""
        response = await client.get(f"/tag/{sample_tag.slug}")
        assert response.status_code == 200
        assert sample_tag.description in response.text

    @pytest.mark.asyncio
    async def test_tag_not_found(self, client: AsyncClient) -> None:
        """Test that non-existent tag returns 404."""
        response = await client.get("/tag/non-existent-tag")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_tag_page_pagination(
        self, client: AsyncClient, sample_tag: Tag, multiple_posts: list[Post]
    ) -> None:
        """Test tag page pagination works."""
        # First page should load
        response = await client.get(f"/tag/{sample_tag.slug}")
        assert response.status_code == 200


class TestGallery:
    """Tests for gallery page."""

    @pytest.mark.asyncio
    async def test_gallery_page_loads(self, client: AsyncClient) -> None:
        """Test that gallery page loads successfully."""
        response = await client.get("/gallery")
        assert response.status_code == 200
        assert "Gallery" in response.text
        assert "text/html" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_gallery_shows_posts_with_thumbnails(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test gallery shows posts that have thumbnails."""
        response = await client.get("/gallery")
        assert response.status_code == 200
        assert published_post.title in response.text

    @pytest.mark.asyncio
    async def test_gallery_filter_by_tag(
        self, client: AsyncClient, sample_tag: Tag, published_post: Post
    ) -> None:
        """Test gallery can filter by tag."""
        response = await client.get(f"/gallery?tag={sample_tag.slug}")
        assert response.status_code == 200
        assert published_post.title in response.text

    @pytest.mark.asyncio
    async def test_gallery_empty_state(self, client: AsyncClient) -> None:
        """Test gallery shows empty state when no images."""
        response = await client.get("/gallery")
        assert response.status_code == 200
        assert "No photos yet" in response.text

    @pytest.mark.asyncio
    async def test_gallery_pagination(
        self, client: AsyncClient, multiple_posts: list[Post]
    ) -> None:
        """Test gallery pagination works."""
        response = await client.get("/gallery")
        assert response.status_code == 200

        response = await client.get("/gallery?page=2")
        assert response.status_code == 200


class TestMetaTags:
    """Tests for SEO meta tags."""

    @pytest.mark.asyncio
    async def test_post_has_og_tags(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that post pages have Open Graph meta tags."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert 'property="og:title"' in response.text
        assert 'property="og:type"' in response.text
        assert 'property="og:url"' in response.text

    @pytest.mark.asyncio
    async def test_post_has_article_tags(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that post pages have article meta tags."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert 'property="article:published_time"' in response.text


class TestNavigation:
    """Tests for navigation elements."""

    @pytest.mark.asyncio
    async def test_homepage_has_nav(self, client: AsyncClient) -> None:
        """Test homepage has navigation links."""
        response = await client.get("/")
        assert response.status_code == 200
        assert 'href="/"' in response.text
        assert 'href="/gallery"' in response.text

    @pytest.mark.asyncio
    async def test_post_has_prev_next_navigation(
        self, client: AsyncClient, multiple_posts: list[Post]
    ) -> None:
        """Test post page has prev/next navigation."""
        # Get a middle post
        middle_post = multiple_posts[5]
        response = await client.get(f"/posts/{middle_post.slug}")
        assert response.status_code == 200
        # Should have navigation links
        assert "Previous Post" in response.text or "Next Post" in response.text
