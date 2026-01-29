"""Tests for media API endpoints."""

import io
from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import SESSION_COOKIE_NAME
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


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


class TestMediaUpload:
    """Test cases for media upload endpoint."""

    @pytest.mark.asyncio
    async def test_upload_requires_auth(self, client: AsyncClient) -> None:
        """Test that upload requires authentication."""
        image_data = create_test_image()
        files = {"file": ("test.jpg", image_data, "image/jpeg")}

        response = await client.post("/api/media/upload", files=files)
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_upload_image_success(
        self, client: AsyncClient, auth_cookies: dict, tmp_path: Path
    ) -> None:
        """Test successful image upload."""
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


class TestMediaList:
    """Test cases for media list endpoint."""

    @pytest.mark.asyncio
    async def test_list_requires_auth(self, client: AsyncClient) -> None:
        """Test that list requires authentication."""
        response = await client.get("/api/media")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_list_empty(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test listing media when none exists."""
        response = await client.get(
            "/api/media",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["media"] == []
        assert data["total"] == 0
        assert data["page"] == 1

    @pytest.mark.asyncio
    async def test_list_with_pagination(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test list pagination parameters."""
        response = await client.get(
            "/api/media",
            params={"page": 2, "per_page": 5},
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["page"] == 2
        assert data["per_page"] == 5


class TestMediaStats:
    """Test cases for storage stats endpoint."""

    @pytest.mark.asyncio
    async def test_stats_requires_auth(self, client: AsyncClient) -> None:
        """Test that stats requires authentication."""
        response = await client.get("/api/media/stats")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_stats_empty_storage(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test stats when storage is empty."""
        response = await client.get(
            "/api/media/stats",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_files"] == 0
        assert data["total_size_bytes"] == 0
        assert "quota_bytes" in data
        assert "usage_percent" in data


class TestMediaOrphaned:
    """Test cases for orphaned media endpoints."""

    @pytest.mark.asyncio
    async def test_list_orphaned_requires_auth(self, client: AsyncClient) -> None:
        """Test that list orphaned requires authentication."""
        response = await client.get("/api/media/orphaned")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_list_orphaned_empty(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test listing orphaned media when none exists."""
        response = await client.get(
            "/api/media/orphaned",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["media"] == []
        assert data["total"] == 0

    @pytest.mark.asyncio
    async def test_delete_orphaned_empty(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test deleting orphaned when none exists."""
        response = await client.delete(
            "/api/media/orphaned",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["deleted_count"] == 0


class TestMediaDelete:
    """Test cases for media delete endpoint."""

    @pytest.mark.asyncio
    async def test_delete_requires_auth(self, client: AsyncClient) -> None:
        """Test that delete requires authentication."""
        response = await client.delete("/api/media/1")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_delete_not_found(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test deleting non-existent media."""
        response = await client.delete(
            "/api/media/99999",
            cookies=auth_cookies,
        )

        assert response.status_code == 404


class TestMediaGet:
    """Test cases for get media endpoint."""

    @pytest.mark.asyncio
    async def test_get_requires_auth(self, client: AsyncClient) -> None:
        """Test that get requires authentication."""
        response = await client.get("/api/media/1")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_get_not_found(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test getting non-existent media."""
        response = await client.get(
            "/api/media/99999",
            cookies=auth_cookies,
        )

        assert response.status_code == 404


class TestMediaUpdate:
    """Test cases for media update endpoint."""

    @pytest.mark.asyncio
    async def test_update_requires_auth(self, client: AsyncClient) -> None:
        """Test that update requires authentication."""
        response = await client.patch(
            "/api/media/1",
            json={"alt_text": "New alt text"},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_update_not_found(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test updating non-existent media."""
        response = await client.patch(
            "/api/media/99999",
            json={"alt_text": "New alt text"},
            cookies=auth_cookies,
        )

        assert response.status_code == 404
