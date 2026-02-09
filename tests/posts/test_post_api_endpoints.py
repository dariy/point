"""Tests for posts API endpoints."""

# Standard library
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

# Third-party
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# Local
from app.models.post import Post, PostFormatter, PostStatus
from app.models.session import Session
from app.models.user import User
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService, hash_token


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
async def second_user(db: AsyncSession) -> dict:
    """Create a second test user."""
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="user2",
        email="user2@example.com",
        password="password123",
        display_name="User Two",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()
    return {"username": "user2", "password": "password123", "user": user}


@pytest.fixture
async def auth_cookies(client: AsyncClient, test_user: dict) -> dict:
    """Login and return auth cookies."""
    response = await client.post(
        "/api/auth/login",
        json={
            "username": test_user["username"],
            "name": test_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


@pytest.fixture
async def second_user_cookies(client: AsyncClient, second_user: dict) -> dict:
    """Login second user."""
    response = await client.post(
        "/api/auth/login",
        json={
            "username": second_user["username"],
            "name": second_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


@pytest.fixture
async def auth_headers(client: AsyncClient, db: AsyncSession):
    """Create auth headers with session token."""
    user = User(
        username="poster",
        email="p@test.com",
        password_hash="hash",
        display_name="Poster",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    session = Session(
        user_id=user.id,
        token=hash_token("post-token"),
        expires_at=datetime.now(UTC) + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test",
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=post-token"}


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
                "title": "Sample Post",
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

    @pytest.mark.asyncio
    async def test_create_post_validation(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        """Test post creation validation."""
        resp = await client.post(
            "/api/posts", json={"content": "c"}, headers=auth_headers
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_create_post_slug_collision(
        self, client: AsyncClient, auth_headers: dict, db: AsyncSession
    ) -> None:
        """Test slug collision is handled."""
        user = await db.scalar(select(User).where(User.username == "poster"))

        # Pre-create post with specific slug
        p = Post(
            title="My Slug",
            slug="my-slug",
            content="C",
            status=PostStatus.DRAFT,
            author_id=user.id,
        )
        db.add(p)
        await db.commit()

        # Try creating another with same title -> should get unique slug
        data = {"title": "My Slug", "content": "New content", "status": "draft"}
        resp = await client.post("/api/posts", json=data, headers=auth_headers)
        assert resp.status_code == 201
        assert resp.json()["slug"] != "my-slug"
        assert resp.json()["slug"].startswith("my-slug-")


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

    @pytest.mark.asyncio
    async def test_get_post_draft_permissions(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict,
        second_user_cookies: dict,
        test_user: dict,
    ) -> None:
        """Test permissions for viewing draft posts."""
        user = test_user["user"]
        post = Post(
            title="Draft",
            slug="draft",
            content="c",
            status=PostStatus.DRAFT,
            author_id=user.id,
        )
        db.add(post)
        await db.commit()

        # Owner can view
        resp = await client.get(f"/api/posts/{post.id}", cookies=auth_cookies)
        assert resp.status_code == 200

        # Unauthenticated -> 404
        resp = await client.get(f"/api/posts/{post.id}")
        assert resp.status_code == 404

        # Other user -> 404
        resp = await client.get(f"/api/posts/{post.id}", cookies=second_user_cookies)
        assert resp.status_code == 404


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

    @pytest.mark.asyncio
    async def test_list_posts_status_filter(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test filtering posts by status."""
        user = test_user["user"]

        # Create posts with different statuses
        p1 = Post(
            title="Pub",
            slug="pub",
            content="c",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
        )
        p2 = Post(
            title="Draft",
            slug="draft",
            content="c",
            status=PostStatus.DRAFT,
            author_id=user.id,
        )
        p3 = Post(
            title="Hidden",
            slug="hidden",
            content="c",
            status=PostStatus.HIDDEN,
            author_id=user.id,
        )
        db.add_all([p1, p2, p3])
        await db.commit()

        # Filter by DRAFT
        resp = await client.get("/api/posts?status=draft", cookies=auth_cookies)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["posts"]) == 1
        assert data["posts"][0]["slug"] == "draft"


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

    @pytest.mark.asyncio
    async def test_update_post_full(
        self, client: AsyncClient, auth_headers: dict, db: AsyncSession
    ) -> None:
        """Test updating a post."""
        user = await db.scalar(select(User).where(User.username == "poster"))
        p = Post(
            title="Old",
            slug="old",
            content="Old",
            status=PostStatus.DRAFT,
            author_id=user.id,
        )
        db.add(p)
        await db.commit()

        data = {"title": "New Title", "content": "New Content", "status": "published"}
        resp = await client.put(f"/api/posts/{p.id}", json=data, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["title"] == "New Title"
        assert resp.json()["status"] == "published"

    @pytest.mark.asyncio
    async def test_update_post_not_found_or_denied(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test update post returning None (not found/denied)."""
        with patch(
            "app.services.post_service.PostService.update_post_with_tags"
        ) as mock_update:
            mock_update.return_value = None

            response = await client.put(
                "/api/posts/999",
                json={"title": "Updated", "content": "c", "status": "draft"},
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

        # Verify post is deleted
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

    @pytest.mark.asyncio
    async def test_delete_post(
        self, client: AsyncClient, auth_headers: dict, db: AsyncSession
    ) -> None:
        """Test deleting a post."""
        user = await db.scalar(select(User).where(User.username == "poster"))
        p = Post(
            title="Del",
            slug="del",
            content="Del",
            status=PostStatus.DRAFT,
            author_id=user.id,
        )
        db.add(p)
        await db.commit()

        resp = await client.delete(f"/api/posts/{p.id}", headers=auth_headers)
        assert resp.status_code == 204

        # Verify gone
        resp = await client.get(f"/api/posts/{p.id}", headers=auth_headers)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_post_failed(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test delete post failing."""
        with patch("app.services.post_service.PostService.delete_post") as mock_delete:
            mock_delete.return_value = False

            response = await client.delete("/api/posts/999", cookies=auth_cookies)
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

        assert response.status_code == 200
        assert response.json()["status"] == "published"

    @pytest.mark.asyncio
    async def test_publish_post_permissions(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict,
        second_user_cookies: dict,
        test_user: dict,
    ) -> None:
        """Test permissions for publishing posts."""
        user = test_user["user"]
        post = Post(
            title="Draft",
            slug="draft",
            content="c",
            status=PostStatus.DRAFT,
            author_id=user.id,
        )
        db.add(post)
        await db.commit()

        # Other user cannot publish -> 404
        resp = await client.post(
            f"/api/posts/{post.id}/publish", cookies=second_user_cookies
        )
        assert resp.status_code == 404

        # Post not found -> 404
        resp = await client.post("/api/posts/99999/publish", cookies=auth_cookies)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_publish_post_denied(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test publish post denied (not author)."""
        user2 = User(
            username="user3", email="u3@e.com", password_hash="hash", display_name="U3"
        )
        db.add(user2)
        await db.commit()

        post = Post(
            title="U3 Draft",
            slug="u3-draft",
            content="c",
            status=PostStatus.DRAFT,
            formatter=PostFormatter.MARKDOWN,
            author_id=user2.id,
        )
        db.add(post)
        await db.commit()

        response = await client.post(
            f"/api/posts/{post.id}/publish", cookies=auth_cookies
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_publish_post_failed_service(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test publish post service returns None."""
        post = Post(
            title="My Draft",
            slug="my-draft",
            content="c",
            status=PostStatus.DRAFT,
            formatter=PostFormatter.MARKDOWN,
            author_id=1,
        )
        db.add(post)
        await db.commit()

        with patch("app.services.post_service.PostService.publish_post") as mock_pub:
            mock_pub.return_value = None
            response = await client.post(
                f"/api/posts/{post.id}/publish", cookies=auth_cookies
            )
            assert response.status_code == 404


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

        assert response.status_code == 200
        assert response.json()["status"] == "draft"

    @pytest.mark.asyncio
    async def test_withdraw_post_permissions(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict,
        second_user_cookies: dict,
        test_user: dict,
    ) -> None:
        """Test permissions for withdrawing posts."""
        user = test_user["user"]
        post = Post(
            title="Pub",
            slug="pub",
            content="c",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            published_at=datetime.now(UTC),
        )
        db.add(post)
        await db.commit()

        # Other user cannot withdraw -> 404
        resp = await client.post(
            f"/api/posts/{post.id}/withdraw", cookies=second_user_cookies
        )
        assert resp.status_code == 404

        # Post not found -> 404
        resp = await client.post("/api/posts/99999/withdraw", cookies=auth_cookies)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_withdraw_post_denied(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test withdraw post denied (not author)."""
        user2 = User(
            username="user4", email="u4@e.com", password_hash="hash", display_name="U4"
        )
        db.add(user2)
        await db.commit()

        post = Post(
            title="U4 Pub",
            slug="u4-pub",
            content="c",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=user2.id,
        )
        db.add(post)
        await db.commit()

        response = await client.post(
            f"/api/posts/{post.id}/withdraw", cookies=auth_cookies
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_withdraw_post_failed_service(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test withdraw post service returns None."""
        post = Post(
            title="My Pub",
            slug="my-pub",
            content="c",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=1,
        )
        db.add(post)
        await db.commit()

        with patch("app.services.post_service.PostService.withdraw_post") as mock_wd:
            mock_wd.return_value = None
            response = await client.post(
                f"/api/posts/{post.id}/withdraw", cookies=auth_cookies
            )
            assert response.status_code == 404


class TestPreviewLink:
    """Test cases for preview link generation and access."""

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
        self,
        client: AsyncClient,
        auth_cookies: dict,
        sample_post: Post,
        db: AsyncSession,
    ) -> None:
        """Test accessing a draft post via preview link."""
        # Generate preview link
        response = await client.post(
            f"/api/posts/{sample_post.id}/preview",
            cookies=auth_cookies,
        )
        preview_url = response.json()["preview_url"]
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

        assert response.status_code == 410

    @pytest.mark.asyncio
    async def test_generate_preview_link_permissions(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict,
        second_user_cookies: dict,
        test_user: dict,
    ) -> None:
        """Test permissions for generating preview links."""
        user = test_user["user"]
        post = Post(
            title="Draft",
            slug="draft",
            content="c",
            status=PostStatus.DRAFT,
            author_id=user.id,
        )
        db.add(post)
        await db.commit()

        # Other user cannot generate -> 404
        resp = await client.post(
            f"/api/posts/{post.id}/preview", cookies=second_user_cookies
        )
        assert resp.status_code == 404

        # Post not found -> 404
        resp = await client.post("/api/posts/99999/preview", cookies=auth_cookies)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_preview_invalid_token(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test accessing preview with invalid or expired token."""
        user = test_user["user"]
        post = Post(
            title="Draft",
            slug="draft",
            content="c",
            status=PostStatus.DRAFT,
            author_id=user.id,
            preview_token="valid_token",
            preview_expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        db.add(post)
        await db.commit()

        # Valid token
        resp = await client.get(
            f"/api/posts/{post.id}/preview?token=valid_token", cookies=auth_cookies
        )
        assert resp.status_code == 200

        # Invalid token
        resp = await client.get(
            f"/api/posts/{post.id}/preview?token=invalid_token", cookies=auth_cookies
        )
        assert resp.status_code == 404

        # Expired token
        post.preview_expires_at = datetime.now(UTC) - timedelta(hours=1)
        await db.commit()

        resp = await client.get(
            f"/api/posts/{post.id}/preview?token=valid_token", cookies=auth_cookies
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_generate_preview_link_denied(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test generate preview link denied."""
        user2 = User(
            username="user5", email="u5@e.com", password_hash="hash", display_name="U5"
        )
        db.add(user2)
        await db.commit()

        post = Post(
            title="U5 Draft",
            slug="u5-draft",
            content="c",
            status=PostStatus.DRAFT,
            formatter=PostFormatter.MARKDOWN,
            author_id=user2.id,
        )
        db.add(post)
        await db.commit()

        response = await client.post(
            f"/api/posts/{post.id}/preview", cookies=auth_cookies
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_generate_preview_link_failed(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test generate preview link service failure."""
        post = Post(
            title="My Draft 2",
            slug="my-draft-2",
            content="c",
            status=PostStatus.DRAFT,
            formatter=PostFormatter.MARKDOWN,
            author_id=1,
        )
        db.add(post)
        await db.commit()

        with patch(
            "app.services.post_service.PostService.generate_preview_link"
        ) as mock_gen:
            mock_gen.return_value = None
            response = await client.post(
                f"/api/posts/{post.id}/preview", cookies=auth_cookies
            )
            assert response.status_code == 404


class TestPostFormatters:
    """Test cases for content formatters."""

    @pytest.mark.asyncio
    async def test_markdown_formatting(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession, test_user: dict
    ) -> None:
        """Test markdown content is converted to HTML."""
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
