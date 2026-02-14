"""Integration tests for image analysis (auto-fill) functionality.

Tests the /api/media/analyze endpoint and the auto-fill feature.
"""

import io
from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.settings_service import SettingsService


class TestImageAnalysis:
    """Test cases for image analysis endpoint."""

    @pytest.fixture
    async def sample_image(self) -> bytes:
        """Create a sample test image.

        Returns:
            Bytes of a small test image
        """
        # Create a small test image
        img = Image.new("RGB", (100, 100), color="red")
        img_bytes = io.BytesIO()
        img.save(img_bytes, format="JPEG")
        img_bytes.seek(0)
        return img_bytes.getvalue()

    @pytest.mark.asyncio
    async def test_analyze_image_without_genai_endpoint_configured(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that analysis fails when GenAI endpoint is not configured."""
        # Ensure GenAI endpoint is not configured
        settings_service = SettingsService(db)
        await settings_service.update_setting("genai_api_endpoint", "")
        await db.commit()

        # Try to analyze an image
        files = {"file": ("test.jpg", sample_image, "image/jpeg")}
        response = await client.post(
            "/api/media/analyze",
            files=files,
            cookies=auth_cookies,
        )

        # Should return 400 Bad Request
        assert response.status_code == 400
        data = response.json()
        assert "GenAI API endpoint not configured" in data["detail"]
        assert "Settings > General" in data["detail"]

    @pytest.mark.asyncio
    async def test_analyze_image_with_invalid_file_type(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
    ) -> None:
        """Test that analysis fails when file is not an image."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Try to analyze a text file
        files = {"file": ("test.txt", b"not an image", "text/plain")}
        response = await client.post(
            "/api/media/analyze",
            files=files,
            cookies=auth_cookies,
        )

        # Should return 400 Bad Request
        assert response.status_code == 400
        data = response.json()
        assert "File must be an image" in data["detail"]

    @pytest.mark.asyncio
    async def test_analyze_image_success(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test successful image analysis."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock the httpx.AsyncClient.post method
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "Beautiful Sunset Over Ocean",
            "tags": ["sunset", "ocean", "landscape", "nature"],
        }
        mock_response.raise_for_status = Mock()

        # Create a mock client that returns our mock response
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            # Analyze the image
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            # Should return 200 OK
            assert response.status_code == 200
            data = response.json()
            assert data["title"] == "Beautiful Sunset Over Ocean"
            assert len(data["tags"]) == 4
            assert "sunset" in data["tags"]
            assert "ocean" in data["tags"]

    @pytest.mark.asyncio
    async def test_analyze_image_with_excerpt(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that excerpt is properly returned when provided by GenAI API."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock GenAI response with excerpt directly
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "Curated Sonic Shelf",
            "tags": ["music", "analog", "shelf", "cozy", "light"],
            "excerpt": "Dive into the warm glow of this curated collection, where analog beats meet urban chic on a sun-kissed shelf. Pure sonic vibes!"
        }
        mock_response.raise_for_status = Mock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            files = {"file": ("20240803160046_IMG_4106.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            data = response.json()
            assert data["title"] == "Curated Sonic Shelf"
            assert data["excerpt"] == "Dive into the warm glow of this curated collection, where analog beats meet urban chic on a sun-kissed shelf. Pure sonic vibes!"
            assert "2024" in data["tags"]  # Year tag should be added
            assert "music" in data["tags"]

    @pytest.mark.asyncio
    async def test_analyze_image_excerpt_mapping(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that alternative keys are mapped to excerpt."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock GenAI response with 'description' instead of 'excerpt'
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "Test Image",
            "tags": ["test"],
            "description": "This is a test description that should be mapped to excerpt."
        }
        mock_response.raise_for_status = Mock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            data = response.json()
            assert data["excerpt"] == "This is a test description that should be mapped to excerpt."

    @pytest.mark.asyncio
    async def test_analyze_image_wrapped_response(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that wrapped responses (e.g., inside 'data') are handled."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock GenAI response wrapped in 'data'
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "status": "success",
            "data": {
                "title": "Wrapped Title",
                "tags": ["wrapped"],
                "excerpt": "Wrapped excerpt text."
            }
        }
        mock_response.raise_for_status = Mock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            data = response.json()
            assert data["title"] == "Wrapped Title"
            assert data["excerpt"] == "Wrapped excerpt text."
            assert data["tags"] == ["wrapped"]

    @pytest.mark.asyncio
    async def test_analyze_image_content_mapping(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test that 'content' key is mapped to excerpt if excerpt is missing."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock GenAI response with 'content' instead of 'excerpt'
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "Test Image",
            "tags": ["test"],
            "content": "This is content that should be mapped to excerpt."
        }
        mock_response.raise_for_status = Mock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            assert response.status_code == 200
            data = response.json()
            assert data["excerpt"] == "This is content that should be mapped to excerpt."

            # Verify the mock was called with correct endpoint
            mock_client.post.assert_called_once()
            call_args = mock_client.post.call_args
            assert call_args[0][0] == "http://localhost:8080/analyze"

    @pytest.mark.asyncio
    async def test_analyze_image_genai_service_unavailable(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test analysis when GenAI service is unavailable."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Create a mock client that raises RequestError
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.RequestError("Connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            # Analyze the image
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            # Should return 502 Bad Gateway
            assert response.status_code == 502
            data = response.json()
            assert "Failed to connect to GenAI service" in data["detail"]
            assert "Connection refused" in data["detail"]

    @pytest.mark.asyncio
    async def test_analyze_image_genai_service_error(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test analysis when GenAI service returns an error."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock httpx to raise HTTPStatusError
        mock_response = Mock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"
        error = httpx.HTTPStatusError(
            "Server error", request=Mock(), response=mock_response
        )

        # Create a mock client that raises HTTPStatusError
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=error)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            # Analyze the image
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            # Should return 500
            assert response.status_code == 500
            data = response.json()
            assert "GenAI service error" in data["detail"]

    @pytest.mark.asyncio
    async def test_analyze_image_requires_authentication(
        self,
        client: AsyncClient,
        db: AsyncSession,
        sample_image: bytes,
    ) -> None:
        """Test that analysis requires authentication."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Try to analyze without auth cookies
        files = {"file": ("test.jpg", sample_image, "image/jpeg")}
        response = await client.post(
            "/api/media/analyze",
            files=files,
        )

        # Should return 401 Unauthorized
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_analyze_image_empty_response(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test analysis when GenAI returns empty/minimal response."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Mock the httpx.AsyncClient.post method with minimal response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "title": "",
            "tags": [],
        }
        mock_response.raise_for_status = Mock()

        # Create a mock client that returns empty response
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            # Analyze the image
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            # Should return 200 OK even with empty results
            assert response.status_code == 200
            data = response.json()
            assert data["title"] == ""
            assert data["tags"] == []

    @pytest.mark.asyncio
    async def test_analyze_image_timeout(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_cookies: dict[str, str],
        sample_image: bytes,
    ) -> None:
        """Test analysis when GenAI service times out."""
        # Configure GenAI endpoint
        settings_service = SettingsService(db)
        await settings_service.update_setting(
            "genai_api_endpoint", "http://localhost:8080/analyze"
        )
        await db.commit()

        # Create a mock client that raises TimeoutException
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.TimeoutException("Request timed out"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("app.api.media.httpx.AsyncClient", return_value=mock_client):
            # Analyze the image
            files = {"file": ("test.jpg", sample_image, "image/jpeg")}
            response = await client.post(
                "/api/media/analyze",
                files=files,
                cookies=auth_cookies,
            )

            # Should return 502 Bad Gateway
            assert response.status_code == 502
            data = response.json()
            assert "Failed to connect to GenAI service" in data["detail"]
