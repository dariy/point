"""Tests for media management: CRUD operations and Media model."""

from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.services.media_service import MediaService


class TestMediaModel:
    """Tests for Media model properties and behavior."""

    def test_media_model_repr(self) -> None:
        """Test string representation of Media."""
        media = Media(id=1, filename="test.jpg", file_type=FileType.IMAGE)
        assert repr(media) == "<Media(id=1, filename='test.jpg', type='image')>"

    def test_media_model_properties(self) -> None:
        """Test model properties."""
        # Image
        m1 = Media(
            file_type=FileType.IMAGE,
            thumbnail_path="thumb.jpg",
            width=100,
            height=200,
            post_id=None,
        )
        assert m1.is_image
        assert not m1.is_video
        assert not m1.is_audio
        assert m1.has_thumbnail
        assert m1.dimensions == (100, 200)
        assert m1.is_orphaned

        # Video
        m2 = Media(
            file_type=FileType.VIDEO,
            thumbnail_path=None,
            width=None,
            height=None,
            post_id=1,
        )
        assert not m2.is_image
        assert m2.is_video
        assert not m2.is_audio
        assert not m2.has_thumbnail
        assert m2.dimensions is None
        assert not m2.is_orphaned

    def test_media_model_url(self) -> None:
        """Test the simplified URL property."""
        # Standard path
        m1 = Media(original_path="originals/2024/08/test.jpg")
        assert m1.url == "/2024/08/test.jpg"

        # Non-standard path
        m2 = Media(original_path="custom/path/file.png")
        assert m2.url == "/media/custom/path/file.png"


class TestMediaManagementAPI:
    """Test cases for media management API endpoints."""

    @pytest.mark.asyncio
    async def test_get_media_requires_auth(self, client: AsyncClient) -> None:
        """Test that get requires authentication."""
        response = await client.get("/api/media/1")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_get_media_not_found(
        self, client: AsyncClient, auth_cookies: dict[str, str]
    ) -> None:
        """Test getting non-existent media."""
        response = await client.get("/api/media/99999", cookies=auth_cookies)
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_update_media_requires_auth(self, client: AsyncClient) -> None:
        """Test that update requires authentication."""
        response = await client.patch("/api/media/1", json={"alt_text": "New alt text"})
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_update_media_not_found(
        self, client: AsyncClient, auth_cookies: dict[str, str]
    ) -> None:
        """Test updating non-existent media."""
        response = await client.patch(
            "/api/media/99999",
            json={"alt_text": "New alt text"},
            cookies=auth_cookies,
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_update_media_metadata_api(
        self, client: AsyncClient, auth_cookies: dict[str, str], db: AsyncSession
    ) -> None:
        """Test updating media metadata via API."""
        m = Media(
            filename="u.jpg",
            original_path="u.jpg",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=10,
            checksum="c_upd_api",
        )
        db.add(m)
        await db.commit()

        data = {"alt_text": "Updated Alt", "caption": "Updated Caption"}
        resp = await client.patch(f"/api/media/{m.id}", json=data, cookies=auth_cookies)
        assert resp.status_code == 200
        assert resp.json()["alt_text"] == "Updated Alt"

    @pytest.mark.asyncio
    async def test_delete_media_requires_auth(self, client: AsyncClient) -> None:
        """Test that delete requires authentication."""
        response = await client.delete("/api/media/1")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_delete_media_not_found_api(
        self, client: AsyncClient, auth_cookies: dict[str, str]
    ) -> None:
        """Test deleting non-existent media via API."""
        response = await client.delete("/api/media/99999", cookies=auth_cookies)
        assert response.status_code == 404


class TestMediaManagementService:
    """Unit tests for media management via MediaService."""

    @pytest.mark.asyncio
    async def test_get_media_by_id(self, db: AsyncSession) -> None:
        """Test retrieving media by ID."""
        service = MediaService(db)
        m = Media(
            filename="get.jpg",
            original_path="p",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=10,
            checksum="c_get",
        )
        db.add(m)
        await db.commit()

        found = await service.get_media_by_id(m.id)
        assert found is not None
        assert found.filename == "get.jpg"

        # Not found branch (line 349)
        assert await service.get_media_by_id(9999) is None

    @pytest.mark.asyncio
    async def test_get_media_by_checksum(self, db: AsyncSession) -> None:
        """Test retrieving media by checksum (line 257)."""
        service = MediaService(db)
        checksum = "checksum123"
        m = Media(
            filename="chk.jpg",
            original_path="p",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=1,
            checksum=checksum,
        )
        db.add(m)
        await db.commit()

        found = await service.get_media_by_checksum(checksum)
        assert found is not None
        assert found.id == m.id

    @pytest.mark.asyncio
    async def test_update_media_metadata_service(
        self, db: AsyncSession, test_user: dict[str, Any]
    ) -> None:
        """Test updating media metadata via service."""
        from app.models.post import Post, PostFormatter, PostStatus

        post = Post(
            title="P",
            slug="p_upd",
            content="C",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=test_user["user"].id,
        )
        db.add(post)
        await db.commit()

        service = MediaService(db)
        m = Media(
            filename="test.jpg",
            original_path="p",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=100,
            checksum="c_upd_srv",
        )
        db.add(m)
        await db.commit()

        # Full update
        updated = await service.update_media(
            m.id, alt_text="Alt", caption="Cap", post_id=post.id
        )
        assert updated is not None
        assert updated.alt_text == "Alt"
        assert updated.caption == "Cap"
        assert updated.post_id == post.id

        # None branches (lines 325-329)
        await service.update_media(m.id, alt_text=None, caption=None, post_id=None)
        assert updated.alt_text == "Alt"  # Should remain unchanged in service logic

        # Not found
        assert await service.update_media(999) is None

    @pytest.mark.asyncio
    async def test_delete_media_service(self, db: AsyncSession, tmp_path: Path) -> None:
        """Test deleting media removes physical files and DB records."""
        service = MediaService(db)
        # Fix: ensure service uses tmp_path
        service.storage_path = tmp_path
        service.originals_path = tmp_path / "media" / "originals"
        service.thumbnails_path = tmp_path / "media" / "thumbnails"

        media = await service.upload_file(b"delete me", "del.mp4", "video/mp4")

        # Verify files exist
        original = service.storage_path / "media" / media.original_path
        assert original.exists()

        success, freed = await service.delete_media(media.id)
        assert success
        assert freed == len(b"delete me")
        assert not original.exists()

        # Not found branch (line 455)
        success, freed = await service.delete_media(9999)
        assert not success

    @pytest.mark.asyncio
    async def test_delete_media_thumbnail_cleanup(
        self, db: AsyncSession, tmp_path: Path
    ) -> None:
        """Test delete_media removes thumbnails (lines 465-467)."""
        service = MediaService(db)
        service.storage_path = tmp_path

        m = Media(
            filename="d.jpg",
            original_path="originals/2026/02/d.jpg",
            thumbnail_path="thumbnails/2026/02/d.jpg",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=1,
            checksum="d_thumb_del",
        )
        db.add(m)
        await db.commit()

        if m.thumbnail_path:
            thumb_full = tmp_path / "media" / m.thumbnail_path
            thumb_full.parent.mkdir(parents=True, exist_ok=True)
            thumb_full.touch()

            success, _ = await service.delete_media(m.id)
            assert success
            assert not thumb_full.exists()
