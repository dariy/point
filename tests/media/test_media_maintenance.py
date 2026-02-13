"""Tests for media maintenance: storage stats and orphaned media cleanup."""

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.services.media_service import MediaService


class TestMediaMaintenanceAPI:
    """Test cases for media maintenance API endpoints."""

    @pytest.mark.asyncio
    async def test_stats_requires_auth(self, client: AsyncClient) -> None:
        """Test that stats requires authentication."""
        response = await client.get("/api/media/stats")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_media_stats_api(
        self, client: AsyncClient, auth_cookies: dict[str, str]
    ) -> None:
        """Test media stats endpoint."""
        resp = await client.get("/api/media/stats", cookies=auth_cookies)
        assert resp.status_code == 200
        assert "total_size_mb" in resp.json()

    @pytest.mark.asyncio
    async def test_list_orphaned_api(
        self, client: AsyncClient, auth_cookies: dict[str, str]
    ) -> None:
        """Test listing orphaned media via API."""
        response = await client.get("/api/media/orphaned", cookies=auth_cookies)
        assert response.status_code == 200
        assert "media" in response.json()


class TestMediaMaintenanceService:
    """Unit tests for media maintenance via MediaService."""

    @pytest.mark.asyncio
    async def test_calculate_storage_usage_empty(self, db: AsyncSession) -> None:
        """Test storage usage when empty."""
        service = MediaService(db)
        usage = await service.calculate_storage_usage()
        assert usage == 0

    @pytest.mark.asyncio
    async def test_cleanup_orphaned_service(self, db: AsyncSession, test_user: dict[str, Any]) -> None:
        """Test cleanup of orphaned media."""
        from app.models.post import Post, PostStatus
        service = MediaService(db)
        old_time = datetime.now(UTC) - timedelta(days=2)

        # Orphaned
        m1 = Media(filename="o1.jpg", original_path="o1.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum="c1", uploaded_at=old_time)
        # Linked
        m2 = Media(filename="o2.jpg", original_path="o2.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=20, checksum="c2", uploaded_at=old_time)
        db.add_all([m1, m2])
        await db.flush()

        post = Post(title="T", slug="t_maint", content="C", status=PostStatus.PUBLISHED, author_id=test_user["user"].id)
        db.add(post)
        await db.flush()

        # Link m2 to post via post_id
        m2.post_id = post.id
        await db.commit()

        with pytest.MonkeyPatch().context() as m:
            # Prevent actual file deletion attempts
            m.setattr("aiofiles.os.remove", AsyncMock())
            m.setattr("pathlib.Path.exists", lambda x: False)

            deleted, freed = await service.cleanup_orphaned()
            assert deleted >= 1
            assert freed >= 10

    @pytest.mark.asyncio
    async def test_get_orphaned_media_scanners(self, db: AsyncSession, test_user: dict[str, Any]) -> None:
        """Test orphaned media scanners (Avatar, Settings, Post thumbnail)."""
        from app.models.post import Post
        from app.models.settings import BlogSettings
        from app.models.user import User
        service = MediaService(db)
        old_date = datetime.now(UTC) - timedelta(hours=48)

        # 1. Avatar
        m1 = Media(filename="a.jpg", original_path="originals/a.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=1, checksum="unique_a_m", uploaded_at=old_date)
        db.add(m1)
        user = await db.get(User, test_user["user"].id)
        if user:
            user.avatar_path = "![](/media/originals/a.jpg)"

        # 2. Settings
        m2 = Media(filename="s.jpg", original_path="originals/s.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=1, checksum="unique_s_m", uploaded_at=old_date)
        db.add(m2)
        db.add(BlogSettings(key="logo_m", value="![](/media/originals/s.jpg)"))

        # 3. Post thumbnail (line 522 fallback)
        m3 = Media(filename="p.jpg", original_path="originals/p.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=1, checksum="unique_p_m", uploaded_at=old_date)
        db.add(m3)
        post = Post(title="T", slug="t_m", content="C", thumbnail_path="![](/media/originals/p.jpg)", author_id=test_user["user"].id)
        db.add(post)

        await db.commit()
        orphaned, count, _ = await service.get_orphaned_media()
        orph_names = [m.filename for m in orphaned]
        assert "a.jpg" not in orph_names
        assert "s.jpg" not in orph_names
        assert "p.jpg" not in orph_names
