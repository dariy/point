"""Tests for simplified media serving and notation."""

from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.utils.formatters import format_content


@pytest.fixture
def patch_storage(tmp_path):
    """Patch settings.storage_path for tests."""
    with patch("app.main.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path)
        # Also patch MediaService's settings if needed
        with patch("app.services.media_service.get_settings") as mock_service_settings:
            mock_service_settings.return_value.storage_path = str(tmp_path)
            yield tmp_path


@pytest.mark.asyncio
async def test_serve_simplified_media(
    client: AsyncClient, db: AsyncSession, patch_storage
):
    """Test the simplified media serving route."""
    tmp_path = patch_storage

    # Create directory structure
    media_dir = tmp_path / "media" / "originals" / "2024" / "08"
    media_dir.mkdir(parents=True, exist_ok=True)

    file_path = media_dir / "test.jpg"
    file_path.write_bytes(b"dummy image content")

    # Create media record in DB
    media = Media(
        filename="test.jpg",
        original_path="originals/2024/08/test.jpg",
        file_type=FileType.IMAGE,
        mime_type="image/jpeg",
        file_size=19,
        checksum="dummy_simple",
    )
    db.add(media)
    await db.commit()

    # Test serving via simplified route
    response = await client.get("/2024/08/test.jpg")
    assert response.status_code == 200
    assert response.content == b"dummy image content"
    assert response.headers["content-type"] == "image/jpeg"


@pytest.mark.asyncio
async def test_serve_simplified_media_not_found(client: AsyncClient, patch_storage):
    """Test 404 for missing simplified media."""
    response = await client.get("/2024/08/nonexistent.jpg")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_simplified_notation_rendering():
    """Test that simplified notation is rendered correctly."""
    content = "/2024/08/image.jpg"
    rendered = format_content(content, "markdown")
    assert 'src="/2024/08/image.jpg"' in rendered
    assert 'alt="image.jpg"' in rendered

    content_video = "/2024/08/video.mp4"
    rendered_video = format_content(content_video, "markdown")
    assert '<video src="/2024/08/video.mp4"' in rendered_video
    assert "controls" in rendered_video


@pytest.mark.asyncio
async def test_simplified_notation_mixed_content():
    """Test simplified notation mixed with other content."""
    content = "Check out this image:\n/2024/08/image.jpg\nIt is cool."
    rendered = format_content(content, "markdown")
    assert "Check out this image:" in rendered
    assert 'src="/2024/08/image.jpg"' in rendered
    assert "It is cool." in rendered
