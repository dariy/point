"""Tests for tag cloud functionality."""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
import pytest

from app.schemas.tag import TagCreate
from app.services.tag_service import TagService


class TestTagCloudAPI:
    """Test tag cloud API endpoints."""

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


class TestTagCloudService:
    """Test tag cloud service operations."""

    @pytest.mark.asyncio
    async def test_tag_cloud_single_tag(self, db: AsyncSession):
        """Test tag cloud weight calculation with single tag."""
        service = TagService(db)
        t1 = await service.create_tag(TagCreate(name="Tag1", is_featured=True))
        t1.post_count = 5
        db.add(t1)
        await db.commit()

        cloud = await service.get_tag_cloud(featured=True)
        assert len(cloud) == 1
        # With single tag: count_range = max(5-5, 1) = 1
        # weight = (5-5)/1 = 0.0
        assert cloud[0]["weight"] == 0.0
