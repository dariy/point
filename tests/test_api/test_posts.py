"""Tests for posts API endpoints."""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials."""
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="testuser",
        email="test@example.com",
        password="testpassword123",
        display_name="Test User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "username": "testuser",
        "password": "testpassword123",
        "user": user,
    }


@pytest.fixture
async def auth_cookies(client: AsyncClient, test_user: dict) -> dict:
    """Login and return auth cookies."""
    response = await client.post(
        "/api/auth/login",
        json={
            "username": test_user["username"],
            "name": test_user["password"],  # API expects 'name' field for password
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


@pytest.fixture
async def sample_post(db: AsyncSession, test_user: dict) -> Post:
    """Create a sample post in the database."""
    post = Post(
        title="Sample Post",
        slug="sample-post",
        content="This is sample content.",
        excerpt="Sample excerpt",
        formatter=PostFormatter.RAW,
        status=PostStatus.DRAFT,
        author_id=test_user["user"].id,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post


@pytest.fixture
async def published_post(db: AsyncSession, test_user: dict) -> Post:
    """Create a published post in the database."""
    post = Post(
        title="Published Post",
        slug="published-post",
        content="This is **published** content.",
        excerpt="Published excerpt",
        formatter=PostFormatter.MARKDOWN,
        status=PostStatus.PUBLISHED,
        author_id=test_user["user"].id,
        published_at=datetime.now(UTC),
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post


class TestCreatePost:
    """Test cases for post creation endpoint."""

    @pytest.mark.asyncio
    async def test_create_post_success(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test successful post creation."""
        response = await client.post(
            "/api/posts",
            json={
                "title": "My First Post",
                "content": "This is the content of my first post.",
                "excerpt": "A short excerpt",
                "formatter": "markdown",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        data = response.json()
        assert data["title"] == "My First Post"
        assert data["slug"] == "my-first-post"
        assert data["content"] == "This is the content of my first post."
        assert data["status"] == "draft"
        assert "id" in data

    @pytest.mark.asyncio
    async def test_create_post_auto_slug(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test slug is auto-generated from title."""
        response = await client.post(
            "/api/posts",
            json={
                "title": "This Is A Test Title!",
                "content": "Content here.",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        assert response.json()["slug"] == "this-is-a-test-title"

    @pytest.mark.asyncio
    async def test_create_post_duplicate_slug_generates_unique(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test duplicate slugs generate unique variant."""
        response = await client.post(
            "/api/posts",
            json={
                "title": "Sample Post",  # Same title as fixture
                "content": "Different content.",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        assert response.json()["slug"] != "sample-post"
        assert response.json()["slug"].startswith("sample-post-")

    @pytest.mark.asyncio
    async def test_create_post_unauthenticated(self, client: AsyncClient) -> None:
        """Test post creation requires authentication."""
        response = await client.post(
            "/api/posts",
            json={
                "title": "Unauthorized Post",
                "content": "Content.",
            },
        )

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_create_post_missing_title(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test post creation requires title."""
        response = await client.post(
            "/api/posts",
            json={
                "content": "Content without title.",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 422


class TestGetPost:
    """Test cases for getting posts."""

    @pytest.mark.asyncio
    async def test_get_post_by_id(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test getting a published post by ID."""
        response = await client.get(f"/api/posts/{published_post.id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == published_post.id
        assert data["title"] == "Published Post"
        assert data["content_html"] is not None

    @pytest.mark.asyncio
    async def test_get_draft_post_unauthenticated(
        self, client: AsyncClient, sample_post: Post
    ) -> None:
        """Test getting a draft post without auth returns 404."""
        response = await client.get(f"/api/posts/{sample_post.id}")

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_draft_post_authenticated(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test getting own draft post when authenticated."""
        response = await client.get(
            f"/api/posts/{sample_post.id}",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert response.json()["status"] == "draft"

    @pytest.mark.asyncio
    async def test_get_nonexistent_post(self, client: AsyncClient) -> None:
        """Test getting a non-existent post returns 404."""
        response = await client.get("/api/posts/99999")

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_post_by_slug(
        self, client: AsyncClient, published_post: Post
    ) -> None:
        """Test getting a post by slug."""
        response = await client.get(f"/api/posts/slug/{published_post.slug}")

        assert response.status_code == 200
        assert response.json()["slug"] == "published-post"


class TestListPosts:
    """Test cases for listing posts."""

    @pytest.mark.asyncio
    async def test_list_posts_empty(self, client: AsyncClient, test_user: dict) -> None:
        """Test listing posts when none exist."""
        response = await client.get("/api/posts")

        assert response.status_code == 200
        data = response.json()
        assert data["posts"] == []
        assert data["total"] == 0

    @pytest.mark.asyncio
    async def test_list_posts_returns_published_only(
        self, client: AsyncClient, sample_post: Post, published_post: Post
    ) -> None:
        """Test listing posts returns only published posts to public."""
        response = await client.get("/api/posts")

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["posts"][0]["slug"] == "published-post"

    @pytest.mark.asyncio
    async def test_list_posts_with_status_filter_authenticated(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test filtering posts by status when authenticated."""
        response = await client.get(
            "/api/posts?status=draft",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["posts"][0]["status"] == "draft"

    @pytest.mark.asyncio
    async def test_list_posts_pagination(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession, test_user: dict
    ) -> None:
        """Test post listing pagination."""
        # Create multiple posts
        for i in range(5):
            post = Post(
                title=f"Post {i}",
                slug=f"post-{i}",
                content=f"Content {i}",
                formatter=PostFormatter.RAW,
                status=PostStatus.PUBLISHED,
                author_id=test_user["user"].id,
                published_at=datetime.now(UTC),
            )
            db.add(post)
        await db.commit()

        # Get first page
        response = await client.get("/api/posts?page=1&per_page=2")
        assert response.status_code == 200
        data = response.json()
        assert len(data["posts"]) == 2
        assert data["total"] == 5
        assert data["page"] == 1
        assert data["per_page"] == 2


class TestUpdatePost:
    """Test cases for updating posts."""

    @pytest.mark.asyncio
    async def test_update_post_success(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test successful post update."""
        response = await client.put(
            f"/api/posts/{sample_post.id}",
            json={
                "title": "Updated Title",
                "content": "Updated content.",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["title"] == "Updated Title"
        assert data["content"] == "Updated content."

    @pytest.mark.asyncio
    async def test_update_post_unauthenticated(
        self, client: AsyncClient, sample_post: Post
    ) -> None:
        """Test post update requires authentication."""
        response = await client.put(
            f"/api/posts/{sample_post.id}",
            json={"title": "Hacked Title"},
        )

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_update_nonexistent_post(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test updating a non-existent post."""
        response = await client.put(
            "/api/posts/99999",
            json={"title": "New Title"},
            cookies=auth_cookies,
        )

        assert response.status_code == 404


class TestDeletePost:
    """Test cases for deleting posts."""

    @pytest.mark.asyncio
    async def test_delete_post_success(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test successful post deletion."""
        post_id = sample_post.id
        response = await client.delete(
            f"/api/posts/{post_id}",
            cookies=auth_cookies,
        )

        assert response.status_code == 204

        # Verify post is deleted by trying to fetch it
        response = await client.get(
            f"/api/posts/{post_id}",
            cookies=auth_cookies,
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_post_unauthenticated(
        self, client: AsyncClient, sample_post: Post
    ) -> None:
        """Test post deletion requires authentication."""
        response = await client.delete(f"/api/posts/{sample_post.id}")

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_delete_nonexistent_post(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test deleting a non-existent post."""
        response = await client.delete(
            "/api/posts/99999",
            cookies=auth_cookies,
        )

        assert response.status_code == 404


class TestPublishPost:
    """Test cases for publishing posts."""

    @pytest.mark.asyncio
    async def test_publish_draft_post(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test publishing a draft post."""
        response = await client.post(
            f"/api/posts/{sample_post.id}/publish",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "published"
        assert data["published_at"] is not None

    @pytest.mark.asyncio
    async def test_publish_already_published(
        self, client: AsyncClient, auth_cookies: dict, published_post: Post
    ) -> None:
        """Test publishing an already published post succeeds (idempotent)."""
        response = await client.post(
            f"/api/posts/{published_post.id}/publish",
            cookies=auth_cookies,
        )

        # Publish is idempotent - already published posts remain published
        assert response.status_code == 200
        assert response.json()["status"] == "published"


class TestWithdrawPost:
    """Test cases for withdrawing posts."""

    @pytest.mark.asyncio
    async def test_withdraw_published_post(
        self, client: AsyncClient, auth_cookies: dict, published_post: Post
    ) -> None:
        """Test withdrawing a published post."""
        response = await client.post(
            f"/api/posts/{published_post.id}/withdraw",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert response.json()["status"] == "draft"

    @pytest.mark.asyncio
    async def test_withdraw_draft_post(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test withdrawing a draft post succeeds (idempotent)."""
        response = await client.post(
            f"/api/posts/{sample_post.id}/withdraw",
            cookies=auth_cookies,
        )

        # Withdraw is idempotent - draft posts remain draft
        assert response.status_code == 200
        assert response.json()["status"] == "draft"


class TestPreviewLink:
    """Test cases for preview link generation."""

    @pytest.mark.asyncio
    async def test_generate_preview_link(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post
    ) -> None:
        """Test generating a preview link."""
        response = await client.post(
            f"/api/posts/{sample_post.id}/preview",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert "preview_url" in data
        assert "expires_at" in data
        assert "/preview/" in data["preview_url"]

    @pytest.mark.asyncio
    async def test_preview_link_access(
        self, client: AsyncClient, auth_cookies: dict, sample_post: Post, db: AsyncSession
    ) -> None:
        """Test accessing a draft post via preview link."""
        # Generate preview link
        response = await client.post(
            f"/api/posts/{sample_post.id}/preview",
            cookies=auth_cookies,
        )
        preview_url = response.json()["preview_url"]
        # Extract token from URL
        token = preview_url.split("/preview/")[-1]

        # Access preview without auth
        response = await client.get(f"/preview/{token}")

        assert response.status_code == 200
        data = response.json()
        assert data["title"] == "Sample Post"
        assert data["preview_mode"] is True

    @pytest.mark.asyncio
    async def test_preview_link_invalid_token(self, client: AsyncClient) -> None:
        """Test accessing preview with invalid token."""
        response = await client.get("/preview/invalidtoken123")

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_preview_link_expired(
        self, client: AsyncClient, db: AsyncSession, test_user: dict
    ) -> None:
        """Test accessing expired preview link."""
        # Create a post with expired preview token
        post = Post(
            title="Expired Preview Post",
            slug="expired-preview-post",
            content="Content",
            formatter=PostFormatter.RAW,
            status=PostStatus.DRAFT,
            author_id=test_user["user"].id,
            preview_token="expiredtoken123",
            preview_expires_at=datetime.now(UTC) - timedelta(days=1),
        )
        db.add(post)
        await db.commit()

        response = await client.get("/preview/expiredtoken123")

        assert response.status_code == 410  # Gone


class TestPostFormatters:
    """Test cases for content formatters."""

    @pytest.mark.asyncio
    async def test_markdown_formatting(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession, test_user: dict
    ) -> None:
        """Test markdown content is converted to HTML."""
        # Create a markdown post
        response = await client.post(
            "/api/posts",
            json={
                "title": "Markdown Post",
                "content": "**Bold** and *italic* text.",
                "formatter": "markdown",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        data = response.json()
        assert "<strong>Bold</strong>" in data["content_html"]
        assert "<em>italic</em>" in data["content_html"]

    @pytest.mark.asyncio
    async def test_raw_formatting(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test raw text content remains as-is."""
        response = await client.post(
            "/api/posts",
            json={
                "title": "Raw Post",
                "content": "**Not bold** text.",
                "formatter": "raw",
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        data = response.json()
        assert "<strong>" not in data["content_html"]
        assert "**Not bold**" in data["content_html"]
