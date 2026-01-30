"""Tests for image processing utilities."""

import io
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from app.utils.image_processor import (
    ImageProcessor,
    calculate_checksum,
    ensure_directory,
    generate_storage_path,
    get_file_type_from_mime,
    is_image_mime,
)


def create_test_image(
    width: int = 100, height: int = 100, format: str = "JPEG", mode: str = "RGB"
) -> bytes:
    """Create a test image in memory."""
    img = Image.new(mode, (width, height), color="red")
    buffer = io.BytesIO()
    img.save(buffer, format=format)
    buffer.seek(0)
    return buffer.read()


class TestImageProcessor:
    """Test cases for ImageProcessor class."""

    @pytest.fixture
    def processor(self) -> ImageProcessor:
        """Create an image processor with default settings."""
        with patch("app.utils.image_processor.get_settings") as mock_settings:
            mock_settings.return_value.max_image_width = 2560
            mock_settings.return_value.thumbnail_size = (180, 120)
            mock_settings.return_value.jpeg_quality = 85
            return ImageProcessor()

    def test_process_image_preserves_dimensions_under_max(
        self, processor: ImageProcessor
    ) -> None:
        """Test that images under max width are not resized."""
        image_data = create_test_image(width=100, height=100)
        result, width, height, format = processor.process_image(image_data)

        assert width == 100
        assert height == 100

    def test_process_image_resizes_large_images(
        self, processor: ImageProcessor
    ) -> None:
        """Test that large images are resized to max width."""
        image_data = create_test_image(width=3000, height=2000)
        processor.max_width = 1000

        result, width, height, format = processor.process_image(image_data)

        assert width == 1000
        # Height should maintain aspect ratio
        assert height == 666 or height == 667

    def test_generate_thumbnail_creates_smaller_image(
        self, processor: ImageProcessor
    ) -> None:
        """Test thumbnail generation creates smaller image."""
        image_data = create_test_image(width=1000, height=800)
        processor.thumbnail_size = (180, 120)

        result, width, height = processor.generate_thumbnail(image_data)

        # Should fit within thumbnail bounds while maintaining aspect ratio
        assert width <= 180
        assert height <= 120

    def test_generate_thumbnail_maintains_aspect_ratio(
        self, processor: ImageProcessor
    ) -> None:
        """Test thumbnail maintains aspect ratio."""
        image_data = create_test_image(width=800, height=400)  # 2:1 ratio
        processor.thumbnail_size = (180, 120)

        result, width, height = processor.generate_thumbnail(image_data)

        # Aspect ratio should be approximately 2:1
        ratio = width / height
        assert 1.9 < ratio < 2.1

    def test_get_image_dimensions(self, processor: ImageProcessor) -> None:
        """Test getting image dimensions."""
        image_data = create_test_image(width=500, height=300)

        width, height = processor.get_image_dimensions(image_data)

        assert width == 500
        assert height == 300

    def test_process_png_image(self, processor: ImageProcessor) -> None:
        """Test processing PNG images."""
        image_data = create_test_image(width=100, height=100, format="PNG")

        result, width, height, format = processor.process_image(image_data)

        assert format == "PNG"
        assert width == 100
        assert height == 100

    def test_process_rgba_image(self, processor: ImageProcessor) -> None:
        """Test processing RGBA images."""
        image_data = create_test_image(
            width=100, height=100, format="PNG", mode="RGBA"
        )

        result, width, height, format = processor.process_image(image_data)

        # Should successfully process
        assert width == 100
        assert height == 100


class TestCalculateChecksum:
    """Test cases for calculate_checksum function."""

    def test_consistent_checksum(self) -> None:
        """Test checksum is consistent for same data."""
        data = b"test data content"
        checksum1 = calculate_checksum(data)
        checksum2 = calculate_checksum(data)

        assert checksum1 == checksum2
        assert len(checksum1) == 64  # SHA256 hex is 64 characters

    def test_different_data_different_checksum(self) -> None:
        """Test different data produces different checksums."""
        checksum1 = calculate_checksum(b"data1")
        checksum2 = calculate_checksum(b"data2")

        assert checksum1 != checksum2


class TestGetFileTypeFromMime:
    """Test cases for get_file_type_from_mime function."""

    def test_image_mime(self) -> None:
        """Test image MIME types."""
        assert get_file_type_from_mime("image/jpeg") == "image"
        assert get_file_type_from_mime("image/png") == "image"

    def test_video_mime(self) -> None:
        """Test video MIME types."""
        assert get_file_type_from_mime("video/mp4") == "video"

    def test_audio_mime(self) -> None:
        """Test audio MIME types."""
        assert get_file_type_from_mime("audio/mpeg") == "audio"

    def test_unknown_mime(self) -> None:
        """Test unknown MIME types default to image."""
        assert get_file_type_from_mime("application/octet-stream") == "image"


class TestIsImageMime:
    """Test cases for is_image_mime function."""

    def test_image_mimes_return_true(self) -> None:
        """Test image MIME types return True."""
        assert is_image_mime("image/jpeg") is True
        assert is_image_mime("image/png") is True
        assert is_image_mime("image/gif") is True

    def test_non_image_mimes_return_false(self) -> None:
        """Test non-image MIME types return False."""
        assert is_image_mime("video/mp4") is False
        assert is_image_mime("audio/mpeg") is False
        assert is_image_mime("text/plain") is False


class TestGenerateStoragePath:
    """Test cases for generate_storage_path function."""

    def test_generates_correct_path(self) -> None:
        """Test correct path structure."""
        result = generate_storage_path("/data", "test.jpg", 2026, 1)

        assert result == Path("/data/2026/01/test.jpg")

    def test_zero_pads_month(self) -> None:
        """Test month is zero-padded."""
        result = generate_storage_path("/data", "file.jpg", 2026, 3)

        assert "03" in str(result)


class TestEnsureDirectory:
    """Test cases for ensure_directory function."""

    def test_creates_directory(self, tmp_path: Path) -> None:
        """Test directory is created."""
        test_dir = tmp_path / "new" / "nested" / "dir"

        ensure_directory(test_dir)

        assert test_dir.exists()
        assert test_dir.is_dir()

    def test_handles_existing_directory(self, tmp_path: Path) -> None:
        """Test existing directory doesn't raise error."""
        test_dir = tmp_path / "existing"
        test_dir.mkdir()

        # Should not raise
        ensure_directory(test_dir)

        assert test_dir.exists()
