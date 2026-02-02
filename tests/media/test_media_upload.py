"""Tests for media upload functionality."""

import io
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType
from app.models.session import Session
from app.models.user import User
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService, hash_token
from app.services.media_service import MediaService
from app.utils.validators import FileValidationError


def create_test_image(width: int = 100, height: int = 100, format: str = "JPEG") -> bytes:
    """Create a test image in memory.

    Args:
        width: Image width
        height: Image height
        format: Image format (JPEG, PNG, etc.)

    Returns:
        Image bytes
    """
    img = Image.new("RGB", (width, height), color="red")
    buffer = io.BytesIO()
    img.save(buffer, format=format)
    buffer.seek(0)
    return buffer.read()


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
async def light_auth_headers(client: AsyncClient, db: AsyncSession):
    """Create light user and return auth headers."""
    user = User(username="media_light", email="ma@test.com", password_hash="hash", display_name="Medialight")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    session = Session(
        user_id=user.id,
        token=hash_token("media-token"),
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=media-token"}


class TestMediaUploadAuth:
    """Test authentication requirements for uploads."""

    @pytest.mark.asyncio
    async def test_upload_requires_auth(self, client: AsyncClient) -> None:
        """Test that upload requires authentication."""
        image_data = create_test_image()
        files = {"file": ("test.jpg", image_data, "image/jpeg")}

        response = await client.post("/api/media/upload", files=files)
        assert response.status_code == 401


class TestMediaUploadSuccess:
    """Test successful upload scenarios."""

    @pytest.mark.asyncio
    async def test_upload_jpeg_image_success(
        self, client: AsyncClient, auth_cookies: dict, tmp_path: Path
    ) -> None:
        """Test successful JPEG image upload."""
        image_data = create_test_image()

        # Patch the storage path to use temp directory
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
        assert "url" in data
        assert "checksum" in data

    @pytest.mark.asyncio
    async def test_upload_png_image(
        self, client: AsyncClient, auth_cookies: dict, tmp_path: Path
    ) -> None:
        """Test successful PNG image upload."""
        image_data = create_test_image(format="PNG")

        with patch("app.services.media_service.get_settings") as mock_settings:
            mock_settings.return_value.storage_path = str(tmp_path)
            mock_settings.return_value.max_upload_size_bytes = 10 * 1024 * 1024
            mock_settings.return_value.storage_quota_bytes = 5000 * 1024 * 1024
            mock_settings.return_value.max_image_width = 2560
            mock_settings.return_value.thumbnail_size = (180, 120)
            mock_settings.return_value.jpeg_quality = 85

            files = {"file": ("test.png", image_data, "image/png")}
            response = await client.post(
                "/api/media/upload",
                files=files,
                cookies=auth_cookies,
            )

        assert response.status_code == 201
        data = response.json()
        assert data["filename"] == "test.png"

    @pytest.mark.asyncio
    async def test_upload_non_image_file(self, db: AsyncSession):
        """Test uploading a non-image file (e.g. video)."""
        service = MediaService(db)
        content = b"video content"
        filename = "test.mp4"
        mime = "video/mp4"

        media = await service.upload_file(content, filename, mime)
        assert media.file_type == FileType.VIDEO
        assert media.thumbnail_path is None  # No thumbnail for video currently


class TestMediaUploadValidation:
    """Test upload validation and error handling."""

    @pytest.mark.asyncio
    async def test_upload_invalid_extension(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test upload with invalid file extension."""
        files = {"file": ("test.exe", b"fake content", "application/octet-stream")}

        response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies,
        )

        assert response.status_code == 400
        assert "not allowed" in response.json()["detail"]["message"]

    @pytest.mark.asyncio
    async def test_upload_media_validation(self, client: AsyncClient, light_auth_headers):
        """Test upload validation errors."""
        # Invalid extension
        files = {'file': ('test.xyz', io.BytesIO(b"test"), 'application/octet-stream')}
        resp = await client.post("/api/media/upload", files=files, headers=light_auth_headers)
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_upload_file_validation_error(self, client: AsyncClient, auth_cookies: dict):
        """Test upload file with validation error."""
        with patch("app.api.media.validate_upload_file") as mock_validate:
            mock_validate.side_effect = Exception("Validation failed")

            files = {"file": ("test.jpg", b"content", "image/jpeg")}
            response = await client.post(
                "/api/media/upload",
                files=files,
                cookies=auth_cookies
            )
            assert response.status_code == 400
            assert "Validation failed" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_upload_file_http_exception(self, client: AsyncClient, auth_cookies: dict):
        """Test upload file with HTTPException from validator."""
        with patch("app.api.media.validate_upload_file") as mock_validate:
            mock_validate.side_effect = HTTPException(status_code=413, detail="Too large")

            files = {"file": ("large.jpg", b"content", "image/jpeg")}
            response = await client.post(
                "/api/media/upload",
                files=files,
                cookies=auth_cookies
            )
            assert response.status_code == 413
            assert "Too large" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_upload_file_service_exception(self, client: AsyncClient, auth_cookies: dict):
        """Test upload file with FileValidationError from service."""
        with patch("app.api.media.validate_upload_file") as mock_validate, \
             patch("app.services.media_service.MediaService.upload_file") as mock_upload:

            mock_validate.return_value = (b"c", "f.jpg", "image/jpeg", 10)
            mock_upload.side_effect = FileValidationError("Service invalid", "field")

            files = {"file": ("test.jpg", b"content", "image/jpeg")}
            response = await client.post(
                "/api/media/upload",
                files=files,
                cookies=auth_cookies
            )
            # The API catches FileValidationError and converts to 400
            assert response.status_code == 400
            detail = response.json()["detail"]
            assert detail["message"] == "Service invalid"


class TestMediaUploadDuplicates:
    """Test duplicate file handling."""

    @pytest.mark.asyncio
    async def test_upload_duplicate_checksum(self, db: AsyncSession):
        """Test uploading duplicate file returns existing record."""
        service = MediaService(db)
        content = b"duplicate content"
        filename = "test.mp4"  # Extension matters for validation
        mime = "video/mp4"

        # First upload
        m1 = await service.upload_file(content, filename, mime)

        # Second upload
        m2 = await service.upload_file(content, "other.mp4", mime)

        assert m1.id == m2.id
        assert m1.checksum == m2.checksum


class TestMultipleFileUpload:
    """Test multiple file upload functionality."""

    @pytest.mark.asyncio
    async def test_upload_multiple_files_partial_failure(self, client: AsyncClient, auth_cookies: dict):
        """Test multiple file upload with some failures."""
        with patch("app.api.media.validate_upload_file") as mock_validate:
            # First call succeeds, second raises
            mock_validate.side_effect = [
                (b"content1", "valid.jpg", "image/jpeg", 100),
                FileValidationError("Invalid file", "file")
            ]

            with patch("app.services.media_service.MediaService.upload_file") as mock_upload, \
                 patch("app.services.media_service.MediaService.get_media_url") as mock_get_url, \
                 patch("app.services.media_service.MediaService.get_thumbnail_url") as mock_get_thumb:

                # Create a proper mock with all required attributes
                mock_media = MagicMock()
                mock_media.id = 1
                mock_media.filename = "valid.jpg"
                mock_media.original_path = "/data/media/originals/2026/01/valid.jpg"
                mock_media.file_type = "image"
                mock_media.file_size = 100
                mock_media.width = 100
                mock_media.height = 100
                mock_media.checksum = "abc123"

                mock_upload.return_value = mock_media
                mock_get_url.return_value = "/media/originals/2026/01/valid.jpg"
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
                assert data["uploaded"][0]["filename"] == "valid.jpg"
                assert data["failed"][0]["filename"] == "invalid.txt"

    @pytest.mark.asyncio
    async def test_upload_multiple_files_generic_error(self, client: AsyncClient, auth_cookies: dict):
        """Test multiple file upload with generic error."""
        with patch("app.api.media.validate_upload_file") as mock_validate:
            mock_validate.side_effect = Exception("Unexpected error")

            files = [("files", ("error.jpg", b"content", "image/jpeg"))]

            response = await client.post(
                "/api/media/upload/multiple",
                files=files,
                cookies=auth_cookies
            )

            assert response.status_code == 201
            data = response.json()
            assert data["total_failed"] == 1
            assert "Unexpected error" in data["failed"][0]["error"]
