"""Tests for file validation utilities."""

import pytest

from app.utils.validators import (
    FileValidationError,
    get_file_type,
    get_file_type_from_extension,
    sanitize_filename,
    validate_file_extension,
    validate_file_size,
    validate_mime_type,
)


class TestValidateFileExtension:
    """Test cases for validate_file_extension."""

    def test_valid_image_extensions(self) -> None:
        """Test valid image extensions."""
        valid_extensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]
        for ext in valid_extensions:
            result = validate_file_extension(f"test{ext}")
            assert result == ext

    def test_valid_video_extensions(self) -> None:
        """Test valid video extensions."""
        valid_extensions = [".mp4", ".mov", ".webm"]
        for ext in valid_extensions:
            result = validate_file_extension(f"test{ext}")
            assert result == ext

    def test_valid_audio_extensions(self) -> None:
        """Test valid audio extensions."""
        valid_extensions = [".mp3", ".wav", ".ogg", ".m4a"]
        for ext in valid_extensions:
            result = validate_file_extension(f"test{ext}")
            assert result == ext

    def test_invalid_extension(self) -> None:
        """Test invalid extension raises error."""
        with pytest.raises(FileValidationError) as exc_info:
            validate_file_extension("test.exe")
        assert "not allowed" in str(exc_info.value)

    def test_no_extension(self) -> None:
        """Test file without extension raises error."""
        with pytest.raises(FileValidationError) as exc_info:
            validate_file_extension("testfile")
        assert "must have an extension" in str(exc_info.value)

    def test_case_insensitive(self) -> None:
        """Test extension validation is case insensitive."""
        result = validate_file_extension("test.JPG")
        assert result == ".jpg"


class TestValidateMimeType:
    """Test cases for validate_mime_type."""

    def test_valid_image_mimes(self) -> None:
        """Test valid image MIME types."""
        valid_mimes = [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
            "image/svg+xml",
        ]
        for mime in valid_mimes:
            result = validate_mime_type(mime, "test.jpg")
            assert result == mime

    def test_valid_video_mimes(self) -> None:
        """Test valid video MIME types."""
        valid_mimes = ["video/mp4", "video/quicktime", "video/webm"]
        for mime in valid_mimes:
            result = validate_mime_type(mime, "test.mp4")
            assert result == mime

    def test_invalid_mime(self) -> None:
        """Test invalid MIME type raises error."""
        with pytest.raises(FileValidationError) as exc_info:
            validate_mime_type("application/pdf", "test.pdf")
        assert "not allowed" in str(exc_info.value)

    def test_fallback_to_filename(self) -> None:
        """Test MIME type fallback to filename detection."""
        result = validate_mime_type(None, "test.jpg")
        assert result == "image/jpeg"


class TestValidateFileSize:
    """Test cases for validate_file_size."""

    def test_valid_size(self) -> None:
        """Test valid file size passes."""
        # 1 MB should be valid with default 10 MB limit
        validate_file_size(1 * 1024 * 1024)

    def test_exceeds_size(self) -> None:
        """Test file exceeding size limit raises error."""
        max_size = 1 * 1024 * 1024  # 1 MB
        file_size = 2 * 1024 * 1024  # 2 MB

        with pytest.raises(FileValidationError) as exc_info:
            validate_file_size(file_size, max_size)
        assert "exceeds maximum" in str(exc_info.value)

    def test_custom_max_size(self) -> None:
        """Test custom max size."""
        max_size = 500 * 1024  # 500 KB
        validate_file_size(400 * 1024, max_size)  # 400 KB should pass


class TestGetFileType:
    """Test cases for get_file_type."""

    def test_image_type(self) -> None:
        """Test image MIME types return 'image'."""
        assert get_file_type("image/jpeg") == "image"
        assert get_file_type("image/png") == "image"

    def test_video_type(self) -> None:
        """Test video MIME types return 'video'."""
        assert get_file_type("video/mp4") == "video"
        assert get_file_type("video/quicktime") == "video"

    def test_audio_type(self) -> None:
        """Test audio MIME types return 'audio'."""
        assert get_file_type("audio/mpeg") == "audio"
        assert get_file_type("audio/wav") == "audio"


class TestGetFileTypeFromExtension:
    """Test cases for get_file_type_from_extension."""

    def test_image_extensions(self) -> None:
        """Test image extensions return 'image'."""
        assert get_file_type_from_extension(".jpg") == "image"
        assert get_file_type_from_extension(".png") == "image"
        assert get_file_type_from_extension(".gif") == "image"

    def test_video_extensions(self) -> None:
        """Test video extensions return 'video'."""
        assert get_file_type_from_extension(".mp4") == "video"
        assert get_file_type_from_extension(".mov") == "video"

    def test_audio_extensions(self) -> None:
        """Test audio extensions return 'audio'."""
        assert get_file_type_from_extension(".mp3") == "audio"
        assert get_file_type_from_extension(".wav") == "audio"


class TestSanitizeFilename:
    """Test cases for sanitize_filename."""

    def test_simple_filename(self) -> None:
        """Test simple filename passes through."""
        result = sanitize_filename("test.jpg")
        assert result == "test.jpg"

    def test_spaces_replaced(self) -> None:
        """Test spaces are replaced with underscores."""
        result = sanitize_filename("my file name.jpg")
        assert result == "my_file_name.jpg"

    def test_special_characters_removed(self) -> None:
        """Test special characters are removed."""
        result = sanitize_filename("test@#$%.jpg")
        assert result == "test.jpg"

    def test_path_traversal_prevented(self) -> None:
        """Test path traversal is prevented."""
        result = sanitize_filename("../../../etc/passwd")
        assert ".." not in result
        assert "/" not in result

    def test_hidden_file_handled(self) -> None:
        """Test hidden files are handled."""
        result = sanitize_filename(".hidden")
        assert not result.startswith(".")
