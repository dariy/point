"""Tests for tag API endpoints."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.auth import UserCreate
from app.schemas.tag import TagCreate
from app.services.auth_service import AuthService
from app.services.tag_service import TagService


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
            "password": test_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


@pytest.fixture
async def sample_tag(db: AsyncSession) -> dict:
    """Create a sample tag."""
    service = TagService(db)
    tag_data = TagCreate(
        name="Travel",
        description="Posts about travel",
        is_important=True,
    )
    tag = await service.create_tag(tag_data)
    await db.commit()

    return {
        "id": tag.id,
        "name": tag.name,
        "slug": tag.slug,
    }


class TestTagList:
    """Test cases for tag list endpoint."""

    @pytest.mark.asyncio
    async def test_list_empty(self, client: AsyncClient) -> None:
        """Test listing tags when none exist."""
        response = await client.get("/api/tags")

        assert response.status_code == 200
        data = response.json()
        assert data["tags"] == []
        assert data["total"] == 0

    @pytest.mark.asyncio
    async def test_list_with_tags(
        self, client: AsyncClient, sample_tag: dict
    ) -> None:
        """Test listing tags with existing tags."""
        response = await client.get("/api/tags")

        assert response.status_code == 200
        data = response.json()
        assert len(data["tags"]) == 1
        assert data["tags"][0]["name"] == sample_tag["name"]

    @pytest.mark.asyncio
    async def test_list_important_only(
        self, client: AsyncClient, db: AsyncSession
    ) -> None:
        """Test filtering for important tags only."""
        # Create important and non-important tags
        service = TagService(db)
        await service.create_tag(TagCreate(name="Important", is_important=True))
        await service.create_tag(TagCreate(name="Regular", is_important=False))
        await db.commit()

        response = await client.get("/api/tags", params={"important_only": True})

        assert response.status_code == 200
        data = response.json()
        assert len(data["tags"]) == 1
        assert data["tags"][0]["name"] == "Important"


class TestTagCreate:
    """Test cases for tag creation endpoint."""

    @pytest.mark.asyncio
    async def test_create_requires_auth(self, client: AsyncClient) -> None:
        """Test that tag creation requires authentication."""
        response = await client.post(
            "/api/tags",
            json={"name": "NewTag"},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_create_tag_success(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test successful tag creation."""
        response = await client.post(
            "/api/tags",
            json={
                "name": "Photography",
                "description": "About photography",
                "is_important": True,
            },
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Photography"
        assert data["slug"] == "photography"
        assert data["is_important"] is True
        assert data["post_count"] == 0

    @pytest.mark.asyncio
    async def test_create_duplicate_name(
        self, client: AsyncClient, auth_cookies: dict, sample_tag: dict
    ) -> None:
        """Test creating tag with duplicate name."""
        response = await client.post(
            "/api/tags",
            json={"name": sample_tag["name"]},
            cookies=auth_cookies,
        )

        assert response.status_code == 409
        assert "already exists" in response.json()["detail"]


class TestTagGet:
    """Test cases for get tag endpoints."""

    @pytest.mark.asyncio
    async def test_get_by_id(
        self, client: AsyncClient, sample_tag: dict
    ) -> None:
        """Test getting tag by ID."""
        response = await client.get(f"/api/tags/{sample_tag['id']}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == sample_tag["id"]
        assert data["name"] == sample_tag["name"]

    @pytest.mark.asyncio
    async def test_get_by_id_not_found(self, client: AsyncClient) -> None:
        """Test getting non-existent tag."""
        response = await client.get("/api/tags/99999")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_by_slug(
        self, client: AsyncClient, sample_tag: dict
    ) -> None:
        """Test getting tag by slug."""
        response = await client.get(f"/api/tags/slug/{sample_tag['slug']}")

        assert response.status_code == 200
        data = response.json()
        assert data["slug"] == sample_tag["slug"]

    @pytest.mark.asyncio
    async def test_get_by_slug_not_found(self, client: AsyncClient) -> None:
        """Test getting tag by non-existent slug."""
        response = await client.get("/api/tags/slug/nonexistent")
        assert response.status_code == 404


class TestTagUpdate:
    """Test cases for tag update endpoint."""

    @pytest.mark.asyncio
    async def test_update_requires_auth(
        self, client: AsyncClient, sample_tag: dict
    ) -> None:
        """Test that update requires authentication."""
        response = await client.put(
            f"/api/tags/{sample_tag['id']}",
            json={"name": "Updated"},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_update_tag_success(
        self, client: AsyncClient, auth_cookies: dict, sample_tag: dict
    ) -> None:
        """Test successful tag update."""
        response = await client.put(
            f"/api/tags/{sample_tag['id']}",
            json={"description": "Updated description", "is_important": False},
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["description"] == "Updated description"
        assert data["is_important"] is False

    @pytest.mark.asyncio
    async def test_update_not_found(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test updating non-existent tag."""
        response = await client.put(
            "/api/tags/99999",
            json={"name": "NewName"},
            cookies=auth_cookies,
        )
        assert response.status_code == 404


class TestTagDelete:
    """Test cases for tag delete endpoint."""

    @pytest.mark.asyncio
    async def test_delete_requires_auth(
        self, client: AsyncClient, sample_tag: dict
    ) -> None:
        """Test that delete requires authentication."""
        response = await client.delete(f"/api/tags/{sample_tag['id']}")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_delete_tag_success(
        self, client: AsyncClient, auth_cookies: dict, sample_tag: dict
    ) -> None:
        """Test successful tag deletion."""
        response = await client.delete(
            f"/api/tags/{sample_tag['id']}",
            cookies=auth_cookies,
        )
        assert response.status_code == 204

        # Verify tag is deleted
        get_response = await client.get(f"/api/tags/{sample_tag['id']}")
        assert get_response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_not_found(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test deleting non-existent tag."""
        response = await client.delete(
            "/api/tags/99999",
            cookies=auth_cookies,
        )
        assert response.status_code == 404


class TestTagCloud:
    """Test cases for tag cloud endpoint."""

    @pytest.mark.asyncio
    async def test_get_tag_cloud_empty(self, client: AsyncClient) -> None:
        """Test tag cloud when no tags have posts."""
        response = await client.get("/api/tags/cloud")

        assert response.status_code == 200
        data = response.json()
        assert data["tags"] == []

    @pytest.mark.asyncio
    async def test_get_tag_cloud_with_limit(self, client: AsyncClient) -> None:
        """Test tag cloud with custom limit."""
        response = await client.get("/api/tags/cloud", params={"limit": 5})

        assert response.status_code == 200


class TestTagPosts:
    """Test cases for tag posts endpoint."""

    @pytest.mark.asyncio
    async def test_get_posts_by_tag(
        self, client: AsyncClient, sample_tag: dict
    ) -> None:
        """Test getting posts by tag."""
        response = await client.get(f"/api/tags/{sample_tag['slug']}/posts")

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == sample_tag["name"]
        assert data["posts"] == []
        assert data["total_posts"] == 0

    @pytest.mark.asyncio
    async def test_get_posts_by_tag_not_found(self, client: AsyncClient) -> None:
        """Test getting posts by non-existent tag."""
        response = await client.get("/api/tags/nonexistent/posts")
        assert response.status_code == 404


class TestRecalculateCounts:
    """Test cases for recalculate counts endpoint."""

    @pytest.mark.asyncio
    async def test_recalculate_requires_auth(self, client: AsyncClient) -> None:
        """Test that recalculate requires authentication."""
        response = await client.post("/api/tags/recalculate-counts")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_recalculate_success(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test successful recalculation."""
        response = await client.post(
            "/api/tags/recalculate-counts",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "success" in response.json()["message"].lower()
