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


class TestRSSFeed:
    """Tests for RSS feed."""

    @pytest.mark.asyncio
    async def test_rss_feed_loads(self, client: AsyncClient) -> None:
        """Test that RSS feed loads successfully."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert "application/rss+xml" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_rss_feed_is_valid_xml(self, client: AsyncClient) -> None:
        """Test that RSS feed is valid XML."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert '<?xml version="1.0"' in response.text
        assert "<rss version=" in response.text
        assert "<channel>" in response.text
        assert "</rss>" in response.text

    @pytest.mark.asyncio
    async def test_rss_feed_contains_posts(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that RSS feed contains published posts."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert published_post.title in response.text
        assert f"/posts/{published_post.slug}" in response.text

    @pytest.mark.asyncio
    async def test_rss_feed_excludes_drafts(
        self, client: AsyncClient, draft_post: Post
    ) -> None:
        """Test that RSS feed excludes draft posts."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert draft_post.title not in response.text

    @pytest.mark.asyncio
    async def test_rss_feed_has_required_elements(
        self, client: AsyncClient
    ) -> None:
        """Test that RSS feed has required channel elements."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert "<title>" in response.text
        assert "<link>" in response.text
        assert "<description>" in response.text
        assert "<lastBuildDate>" in response.text

    @pytest.mark.asyncio
    async def test_rss_feed_has_cache_header(self, client: AsyncClient) -> None:
        """Test that RSS feed has cache control header."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert "Cache-Control" in response.headers

    @pytest.mark.asyncio
    async def test_rss_feed_item_has_required_elements(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that RSS feed items have required elements."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert "<item>" in response.text
        assert "<guid" in response.text
        assert "<pubDate>" in response.text


class TestSitemap:
    """Tests for sitemap."""

    @pytest.mark.asyncio
    async def test_sitemap_loads(self, client: AsyncClient) -> None:
        """Test that sitemap loads successfully."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert "application/xml" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_sitemap_is_valid_xml(self, client: AsyncClient) -> None:
        """Test that sitemap is valid XML."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert '<?xml version="1.0"' in response.text
        assert "<urlset" in response.text
        assert "</urlset>" in response.text

    @pytest.mark.asyncio
    async def test_sitemap_contains_homepage(self, client: AsyncClient) -> None:
        """Test that sitemap contains homepage."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert "<loc>http://test/</loc>" in response.text

    @pytest.mark.asyncio
    async def test_sitemap_contains_gallery(self, client: AsyncClient) -> None:
        """Test that sitemap contains gallery page."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert "<loc>http://test/gallery</loc>" in response.text

    @pytest.mark.asyncio
    async def test_sitemap_contains_posts(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that sitemap contains published posts."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert f"/posts/{published_post.slug}" in response.text

    @pytest.mark.asyncio
    async def test_sitemap_contains_tags(
        self, client: AsyncClient, sample_tag: Tag, published_post: Post
    ) -> None:
        """Test that sitemap contains tags with posts."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert f"/tag/{sample_tag.slug}" in response.text

    @pytest.mark.asyncio
    async def test_sitemap_excludes_drafts(
        self, client: AsyncClient, draft_post: Post
    ) -> None:
        """Test that sitemap excludes draft posts."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert draft_post.slug not in response.text

    @pytest.mark.asyncio
    async def test_sitemap_has_cache_header(self, client: AsyncClient) -> None:
        """Test that sitemap has cache control header."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert "Cache-Control" in response.headers

    @pytest.mark.asyncio
    async def test_sitemap_has_lastmod(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that sitemap entries have lastmod dates."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert "<lastmod>" in response.text


class TestRobotsTxt:
    """Tests for robots.txt."""

    @pytest.mark.asyncio
    async def test_robots_txt_loads(self, client: AsyncClient) -> None:
        """Test that robots.txt loads successfully."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "text/plain" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_robots_txt_has_user_agent(self, client: AsyncClient) -> None:
        """Test that robots.txt has User-agent directive."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "User-agent:" in response.text

    @pytest.mark.asyncio
    async def test_robots_txt_allows_public_pages(
        self, client: AsyncClient
    ) -> None:
        """Test that robots.txt allows public pages."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "Allow: /" in response.text

    @pytest.mark.asyncio
    async def test_robots_txt_disallows_admin(self, client: AsyncClient) -> None:
        """Test that robots.txt disallows admin pages."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "Disallow: /admin/" in response.text

    @pytest.mark.asyncio
    async def test_robots_txt_disallows_api(self, client: AsyncClient) -> None:
        """Test that robots.txt disallows API endpoints."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "Disallow: /api/" in response.text

    @pytest.mark.asyncio
    async def test_robots_txt_has_sitemap(self, client: AsyncClient) -> None:
        """Test that robots.txt references sitemap."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "Sitemap:" in response.text
        assert "/sitemap.xml" in response.text

    @pytest.mark.asyncio
    async def test_robots_txt_has_cache_header(self, client: AsyncClient) -> None:
        """Test that robots.txt has cache control header."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "Cache-Control" in response.headers


class TestTwitterCards:
    """Tests for Twitter Card meta tags."""

    @pytest.mark.asyncio
    async def test_post_has_twitter_card_tags(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test that post pages have Twitter Card meta tags."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert 'name="twitter:card"' in response.text
        assert 'name="twitter:title"' in response.text

    @pytest.mark.asyncio
    async def test_post_with_image_has_large_image_card(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test posts with images use summary_large_image card."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert 'content="summary_large_image"' in response.text

    @pytest.mark.asyncio
    async def test_tag_page_has_twitter_card_tags(
        self, client: AsyncClient, sample_tag: Tag, published_post: Post
    ) -> None:
        """Test that tag pages have Twitter Card meta tags."""
        response = await client.get(f"/tag/{sample_tag.slug}")
        assert response.status_code == 200
        assert 'name="twitter:card"' in response.text


class TestCanonicalURLs:
    """Tests for canonical URLs."""

    @pytest.mark.asyncio
    async def test_homepage_has_canonical(self, client: AsyncClient) -> None:
        """Test homepage has canonical URL."""
        response = await client.get("/")
        assert response.status_code == 200
        assert 'rel="canonical"' in response.text

    @pytest.mark.asyncio
    async def test_post_has_canonical(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test post page has canonical URL."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert 'rel="canonical"' in response.text

    @pytest.mark.asyncio
    async def test_homepage_has_rss_link(self, client: AsyncClient) -> None:
        """Test homepage has RSS feed link."""
        response = await client.get("/")
        assert response.status_code == 200
        assert 'type="application/rss+xml"' in response.text
        assert 'href="/feed.xml"' in response.text


class TestTheming:
    """Tests for theming system."""

    @pytest.mark.asyncio
    async def test_homepage_has_color_scheme_meta(
        self, client: AsyncClient
    ) -> None:
        """Test homepage has color-scheme meta tag."""
        response = await client.get("/")
        assert response.status_code == 200
        assert 'name="color-scheme"' in response.text
        assert 'content="light dark"' in response.text

    @pytest.mark.asyncio
    async def test_homepage_has_theme_toggle(self, client: AsyncClient) -> None:
        """Test homepage has theme toggle button."""
        response = await client.get("/")
        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text
        assert 'Toggle theme' in response.text or 'Toggle dark mode' in response.text

    @pytest.mark.asyncio
    async def test_homepage_has_theme_icons(self, client: AsyncClient) -> None:
        """Test homepage has sun and moon icons for theme toggle."""
        response = await client.get("/")
        assert response.status_code == 200
        assert 'class="icon-sun"' in response.text
        assert 'class="icon-moon"' in response.text

    @pytest.mark.asyncio
    async def test_homepage_loads_theme_js(self, client: AsyncClient) -> None:
        """Test homepage loads theme.js script."""
        response = await client.get("/")
        assert response.status_code == 200
        assert 'src="/static/js/theme.js"' in response.text

    @pytest.mark.asyncio
    async def test_theme_js_file_exists(self, client: AsyncClient) -> None:
        """Test that theme.js file is accessible."""
        response = await client.get("/static/js/theme.js")
        assert response.status_code == 200
        assert "ThemeManager" in response.text

    @pytest.mark.asyncio
    async def test_theme_js_has_toggle_function(
        self, client: AsyncClient
    ) -> None:
        """Test theme.js has toggle functionality."""
        response = await client.get("/static/js/theme.js")
        assert response.status_code == 200
        assert "toggleTheme" in response.text
        assert "data-theme" in response.text

    @pytest.mark.asyncio
    async def test_theme_js_has_system_preference_detection(
        self, client: AsyncClient
    ) -> None:
        """Test theme.js has system preference detection."""
        response = await client.get("/static/js/theme.js")
        assert response.status_code == 200
        assert "prefers-color-scheme" in response.text
        assert "matchMedia" in response.text

    @pytest.mark.asyncio
    async def test_theme_js_has_localStorage_persistence(
        self, client: AsyncClient
    ) -> None:
        """Test theme.js uses localStorage for persistence."""
        response = await client.get("/static/js/theme.js")
        assert response.status_code == 200
        assert "localStorage" in response.text
        assert "theme-preference" in response.text

    @pytest.mark.asyncio
    async def test_post_page_has_theme_toggle(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test post page has theme toggle button."""
        response = await client.get(f"/posts/{published_post.slug}")
        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text

    @pytest.mark.asyncio
    async def test_gallery_has_theme_toggle(self, client: AsyncClient) -> None:
        """Test gallery page has theme toggle button."""
        response = await client.get("/gallery")
        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text

    @pytest.mark.asyncio
    async def test_tag_page_has_theme_toggle(
        self, client: AsyncClient, sample_tag: Tag, published_post: Post
    ) -> None:
        """Test tag page has theme toggle button."""
        response = await client.get(f"/tag/{sample_tag.slug}")
        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text

    @pytest.mark.asyncio
    async def test_main_css_has_dark_theme_variables(
        self, client: AsyncClient
    ) -> None:
        """Test main.css has dark theme CSS variables."""
        response = await client.get("/static/css/main.css")
        assert response.status_code == 200
        assert '[data-theme="dark"]' in response.text
        assert "--bg-primary" in response.text
        assert "--text-primary" in response.text

    @pytest.mark.asyncio
    async def test_main_css_has_light_theme_variables(
        self, client: AsyncClient
    ) -> None:
        """Test main.css has light theme CSS variables."""
        response = await client.get("/static/css/main.css")
        assert response.status_code == 200
        assert '[data-theme="light"]' in response.text or ":root" in response.text

    @pytest.mark.asyncio
    async def test_main_css_has_theme_transition(
        self, client: AsyncClient
    ) -> None:
        """Test main.css has smooth theme transition."""
        response = await client.get("/static/css/main.css")
        assert response.status_code == 200
        assert "--transition-theme" in response.text
