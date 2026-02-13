"""Tests for media upload: validation, success paths, and duplicate detection."""

import io
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType
from app.services.media_service import MediaService
from app.utils.validators import FileValidationError


class TestMediaUploadAPI:
    """Test cases for media upload API endpoints."""

    @pytest.mark.asyncio
    async def test_upload_requires_auth(self, client: AsyncClient) -> None:
        """Test that upload requires authentication."""
        files = {"file": ("test.jpg", b"fake", "image/jpeg")}
        response = await client.post("/api/media/upload", files=files)
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_upload_jpeg_image_success(
        self, client: AsyncClient, auth_cookies: dict[str, str], tmp_path: Path
    ) -> None:
        """Test successful JPEG image upload via API."""
        from PIL import Image
        img = Image.new("RGB", (10, 10), color="red")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        image_data = buf.getvalue()

        with patch("app.services.media_service.get_settings") as mock_settings:
            mock_settings.return_value.storage_path = str(tmp_path)
            mock_settings.return_value.max_upload_size_bytes = 10 * 1024 * 1024
            mock_settings.return_value.storage_quota_bytes = 5000 * 1024 * 1024
            mock_settings.return_value.max_image_width = 2560
            mock_settings.return_value.thumbnail_size = (180, 120)
            mock_settings.return_value.jpeg_quality = 85

            files = {"file": ("test.jpg", image_data, "image/jpeg")}
            response = await client.post(
                "/api/media/upload",
                files=files,
                cookies=auth_cookies,
            )

        assert response.status_code == 201
        data = response.json()
        assert data["filename"] == "test.jpg"
        assert data["file_type"] == "image"

    @pytest.mark.asyncio
    async def test_upload_multiple_files_api(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test multiple file upload functionality including partial failures."""
        with patch("app.api.media.validate_upload_file") as mock_validate:
            # First call succeeds, second raises
            mock_validate.side_effect = [
                (b"content1", "valid.jpg", "image/jpeg", 100),
                FileValidationError("Invalid file", "file")
            ]

            with patch("app.services.media_service.MediaService.upload_file") as mock_upload, \
                 patch("app.services.media_service.MediaService.get_media_url") as mock_get_url, \
                 patch("app.services.media_service.MediaService.get_thumbnail_url") as mock_get_thumb:

                mock_media = MagicMock()
                mock_media.id = 1
                mock_media.filename = "valid.jpg"
                mock_media.original_path = "orig.jpg"
                mock_media.file_type = "image"
                mock_media.file_size = 100
                mock_media.width = 100
                mock_media.height = 100
                mock_media.checksum = "abc123"

                mock_upload.return_value = mock_media
                mock_get_url.return_value = "/media/orig.jpg"
                mock_get_thumb.return_value = "/media/thumbnails/2026/01/valid.jpg"

                files = [
                    ("files", ("valid.jpg", b"content1", "image/jpeg")),
                    ("files", ("invalid.txt", b"content2", "text/plain"))
                ]

                response = await client.post(
                    "/api/media/upload/multiple",
                    files=files,
                    cookies=auth_cookies
                )

                assert response.status_code == 201
                data = response.json()
                assert data["total_uploaded"] == 1
                assert data["total_failed"] == 1

    @pytest.mark.asyncio
    async def test_upload_validation_errors_api(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test various upload validation error paths in API."""
        # 1. Invalid extension
        files = {"file": ("test.exe", b"fake", "application/octet-stream")}
        response = await client.post("/api/media/upload", files=files, cookies=auth_cookies)
        assert response.status_code == 400

        # 2. HTTPException from validator
        with patch("app.api.media.validate_upload_file", side_effect=HTTPException(status_code=413, detail="Too large")):
            response = await client.post("/api/media/upload", files=files, cookies=auth_cookies)
            assert response.status_code == 413


class TestMediaUploadService:
    """Unit tests for file uploading via MediaService."""

    @pytest.mark.asyncio
    async def test_upload_non_image_file(self, db: AsyncSession, tmp_path: Path) -> None:
        """Test uploading non-image files (e.g. video)."""
        service = MediaService(db)
        service.storage_path = tmp_path
        service.originals_path = tmp_path / "media" / "originals"
        service.thumbnails_path = tmp_path / "media" / "thumbnails"
        content = b"video content"
        filename = "test.mp4"
        mime = "video/mp4"

        media = await service.upload_file(content, filename, mime)
        assert media.file_type == FileType.VIDEO
        assert media.thumbnail_path is None

    @pytest.mark.asyncio
    async def test_upload_svg_file(self, db: AsyncSession, tmp_path: Path) -> None:
        """Test SVG upload (IMAGE type but no image processing branch)."""
        service = MediaService(db)
        service.storage_path = tmp_path
        service.originals_path = tmp_path / "media" / "originals"
        service.thumbnails_path = tmp_path / "media" / "thumbnails"
        content = b"<svg></svg>"
        res = await service.upload_file(content, "icon.svg", "image/svg+xml")
        assert res.file_type == FileType.IMAGE
        assert res.thumbnail_path is None

    @pytest.mark.asyncio
    async def test_upload_duplicate_checksum(self, db: AsyncSession, tmp_path: Path) -> None:
        """Test uploading duplicate file returns existing record (line 171)."""
        service = MediaService(db)
        service.storage_path = tmp_path
        service.originals_path = tmp_path / "media" / "originals"
        service.thumbnails_path = tmp_path / "media" / "thumbnails"
        content = b"dup content"
        filename = "dup.mp4"
        mime = "video/mp4"

        m1 = await service.upload_file(content, filename, mime)
        # Second upload with same content
        m2 = await service.upload_file(content, "other.mp4", mime)

        assert m1.id == m2.id
        assert m1.checksum == m2.checksum
