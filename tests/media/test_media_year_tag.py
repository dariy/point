"""Tests for year tag extraction from filename in image analysis.
"""

import io
from unittest.mock import AsyncMock, Mock, patch

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.settings_service import SettingsService


class TestMediaYearTag:
    """Test cases for year tag extraction from filename."""

    @pytest.fixture
    async def sample_image(self) -> bytes:
        """Create a sample test image."""
        img = Image.new("RGB", (100, 100), color="blue")
        img_bytes = io.BytesIO()
        img.save(img_bytes, format="JPEG")
        img_bytes.seek(0)
        return img_bytes.getvalue()

    @pytest.mark.asyncio
    async def test_analyze_image_with_year_in_filename(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that a 20## year tag is extracted from filename."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock the GenAI response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "Test Title",
            "tags": ["nature"],
        }
        mock_response.raise_for_status = Mock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            # Filename starting with 2024
            files = {"file": ("2024-photo.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            data = response.json()
            assert "2024" in data["tags"]
            assert data["tags"][0] == "2024"
            assert "nature" in data["tags"]

    @pytest.mark.asyncio
    async def test_analyze_image_with_year_already_in_tags(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that duplicate year tag is not added if GenAI already returned it."""
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "Test Title",
            "tags": ["2024", "nature"],
        }
        mock_response.raise_for_status = Mock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            files = {"file": ("2024-photo.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            data = response.json()
            assert data["tags"].count("2024") == 1
            assert data["tags"] == ["2024", "nature"]

    @pytest.mark.asyncio
    async def test_analyze_image_without_year_in_filename(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that no extra year tag is added if filename doesn't start with 20##."""
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "Test Title",
            "tags": ["nature"],
        }
        mock_response.raise_for_status = Mock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            # Filename NOT starting with 20##
            files = {"file": ("my-2024-photo.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            data = response.json()
            assert "2024" not in data["tags"]
            assert data["tags"] == ["nature"]
