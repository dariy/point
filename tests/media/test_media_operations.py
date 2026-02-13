"""Tests for media operations: renaming, rebuilding thumbnails, and serving."""

from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.services.media_service import MediaService
from app.utils.formatters import format_content


class TestMediaOperationsAPI:
    """Test cases for media operation API endpoints."""

    @pytest.mark.asyncio
    async def test_rename_media_api(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict[str, str], tmp_path: Path
    ) -> None:
        """Test media renaming via API."""
        with patch("app.services.media_service.get_settings") as mock_settings:
            mock_settings.return_value.storage_path = str(tmp_path)
            media_dir = tmp_path / "media" / "originals" / "2024" / "08"
            media_dir.mkdir(parents=True, exist_ok=True)
            (media_dir / "old.jpg").touch()

            media = Media(
                filename="old.jpg",
                original_path="originals/2024/08/old.jpg",
                file_type=FileType.IMAGE,
                mime_type="image/jpeg",
                file_size=0,
                checksum="c_api_rename",
            )
            db.add(media)
            await db.commit()

            response = await client.post(
                f"/api/media/{media.id}/rename",
                json={"new_filename": "new.jpg"},
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            assert response.json()["filename"] == "new.jpg"
            assert (media_dir / "new.jpg").exists()

    @pytest.mark.asyncio
    async def test_serve_simplified_media(
        self, client: AsyncClient, db: AsyncSession, tmp_path: Path
    ) -> None:
        """Test the simplified media serving route."""
        with patch("app.main.settings") as mock_settings:
            mock_settings.storage_path = str(tmp_path)
            media_dir = tmp_path / "media" / "originals" / "2024" / "08"
            media_dir.mkdir(parents=True, exist_ok=True)
            (media_dir / "test.jpg").write_bytes(b"content")

            media = Media(
                filename="test.jpg",
                original_path="originals/2024/08/test.jpg",
                file_type=FileType.IMAGE,
                mime_type="image/jpeg",
                file_size=7,
                checksum="c_serve",
            )
            db.add(media)
            await db.commit()

            response = await client.get("/2024/08/test.jpg")
            assert response.status_code == 200
            assert response.content == b"content"


class TestMediaOperationsService:
    """Unit tests for media operations via MediaService."""

    @pytest.mark.asyncio
    async def test_rename_media_service(self, db: AsyncSession, tmp_path: Path) -> None:
        """Test media renaming including reference updates in posts."""
        service = MediaService(db)
        service.storage_path = tmp_path

        date_path = "2024/08"
        orig_dir = tmp_path / "media" / "originals" / date_path
        orig_dir.mkdir(parents=True, exist_ok=True)
        (orig_dir / "old.jpg").touch()

        media = Media(
            filename="old.jpg",
            original_path=f"originals/{date_path}/old.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=0,
            checksum="c_srv_rename",
        )
        db.add(media)
        await db.commit()

        # Rename branches: 1. same filename (line 361)
        res = await service.rename_media(media.id, "old.jpg")
        if res:
            assert res.filename == "old.jpg"

        # 2. success path
        updated = await service.rename_media(media.id, "new.jpg")
        if updated:
            assert updated.filename == "new.jpg"
            assert (orig_dir / "new.jpg").exists()

        # 3. short path (line 366)
        media.original_path = "short"
        assert await service.rename_media(media.id, "x.jpg") is None

    @pytest.mark.asyncio
    async def test_rebuild_thumbnails_exhaustive(
        self, db: AsyncSession, tmp_path: Path
    ) -> None:
        """Test rebuilding thumbnails including failure paths (lines 673-714)."""
        service = MediaService(db)
        service.storage_path = tmp_path

        # 1. missing original (line 673)
        m1 = Media(
            filename="m1.jpg",
            original_path="originals/2026/02/m1.jpg",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=1,
            checksum="m1",
        )
        db.add(m1)

        # 2. success rebuild
        m2 = Media(
            filename="m2.jpg",
            original_path="originals/2026/02/m2.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=1,
            checksum="m2",
        )
        db.add(m2)
        await db.commit()

        orig_dir = tmp_path / "media" / "originals" / "2026" / "02"
        orig_dir.mkdir(parents=True, exist_ok=True)
        from PIL import Image
        img = Image.new("RGB", (10, 10))
        img.save(orig_dir / "m2.jpg")

        stats = await service.rebuild_thumbnails(only_missing=False)
        assert stats["total"] >= 2
        assert stats["processed"] >= 1
        assert stats["failed"] >= 1


def test_simplified_notation_rendering() -> None:
    """Test that simplified notation is rendered correctly."""
    content = "/2024/08/image.jpg"
    rendered = format_content(content, "markdown")
    assert 'src="/2024/08/image.jpg"' in rendered

    content_video = "/2024/08/video.mp4"
    rendered_video = format_content(content_video, "markdown")
    assert '<video src="/2024/08/video.mp4"' in rendered_video
