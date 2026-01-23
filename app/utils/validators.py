"""File validation utilities.

Handles validation of uploaded files for type, size, and content.
"""

import mimetypes
from pathlib import Path

from fastapi import HTTPException, UploadFile, status

from app.config import get_settings
from app.schemas.media import (
    ALLOWED_AUDIO_EXTENSIONS,
    ALLOWED_AUDIO_MIMES,
    ALLOWED_EXTENSIONS,
    ALLOWED_IMAGE_EXTENSIONS,
    ALLOWED_IMAGE_MIMES,
    ALLOWED_MIMES,
    ALLOWED_VIDEO_EXTENSIONS,
    ALLOWED_VIDEO_MIMES,
)


class FileValidationError(Exception):
    """Exception raised for file validation failures."""

    def __init__(self, message: str, field: str = "file"):
        self.message = message
        self.field = field
        super().__init__(self.message)


def validate_file_extension(filename: str) -> str:
    """Validate file extension is allowed.

    Args:
        filename: Original filename

    Returns:
        Lowercase file extension (e.g., '.jpg')

    Raises:
        FileValidationError: If extension not allowed
    """
    ext = Path(filename).suffix.lower()
    if not ext:
        raise FileValidationError("File must have an extension")
    if ext not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise FileValidationError(
            f"File extension '{ext}' not allowed. Allowed: {allowed}"
        )
    return ext


def validate_mime_type(content_type: str | None, filename: str) -> str:
    """Validate MIME type is allowed.

    Args:
        content_type: Content-Type header from upload
        filename: Original filename for fallback detection

    Returns:
        Validated MIME type

    Raises:
        FileValidationError: If MIME type not allowed
    """
    # Try to get MIME from content-type header
    mime_type = content_type

    # Fallback to guessing from filename
    if not mime_type or mime_type == "application/octet-stream":
        guessed_mime, _ = mimetypes.guess_type(filename)
        mime_type = guessed_mime or "application/octet-stream"

    if mime_type not in ALLOWED_MIMES:
        allowed = ", ".join(sorted(ALLOWED_MIMES))
        raise FileValidationError(
            f"MIME type '{mime_type}' not allowed. Allowed: {allowed}"
        )

    return mime_type


def validate_file_size(size: int, max_size: int | None = None) -> None:
    """Validate file size is within limits.

    Args:
        size: File size in bytes
        max_size: Maximum allowed size in bytes (defaults to config)

    Raises:
        FileValidationError: If file too large
    """
    settings = get_settings()
    max_size = max_size or settings.max_upload_size_bytes

    if size > max_size:
        max_mb = max_size / (1024 * 1024)
        file_mb = size / (1024 * 1024)
        raise FileValidationError(
            f"File size ({file_mb:.2f} MB) exceeds maximum ({max_mb:.2f} MB)"
        )


def validate_storage_quota(
    current_usage: int,
    new_file_size: int,
    quota: int | None = None,
) -> None:
    """Validate storage quota is not exceeded.

    Args:
        current_usage: Current storage usage in bytes
        new_file_size: Size of new file in bytes
        quota: Storage quota in bytes (defaults to config)

    Raises:
        FileValidationError: If quota would be exceeded
    """
    settings = get_settings()
    quota = quota or settings.storage_quota_bytes

    if current_usage + new_file_size > quota:
        quota_mb = quota / (1024 * 1024)
        used_mb = current_usage / (1024 * 1024)
        new_mb = new_file_size / (1024 * 1024)
        raise FileValidationError(
            f"Storage quota exceeded. Quota: {quota_mb:.2f} MB, "
            f"Used: {used_mb:.2f} MB, File: {new_mb:.2f} MB"
        )


def get_file_type(mime_type: str) -> str:
    """Get file type category from MIME type.

    Args:
        mime_type: MIME type string

    Returns:
        File type: 'image', 'video', or 'audio'
    """
    if mime_type in ALLOWED_IMAGE_MIMES:
        return "image"
    elif mime_type in ALLOWED_VIDEO_MIMES:
        return "video"
    elif mime_type in ALLOWED_AUDIO_MIMES:
        return "audio"
    return "image"  # Default


def get_file_type_from_extension(ext: str) -> str:
    """Get file type category from extension.

    Args:
        ext: File extension (e.g., '.jpg')

    Returns:
        File type: 'image', 'video', or 'audio'
    """
    ext_lower = ext.lower()
    if ext_lower in ALLOWED_IMAGE_EXTENSIONS:
        return "image"
    elif ext_lower in ALLOWED_VIDEO_EXTENSIONS:
        return "video"
    elif ext_lower in ALLOWED_AUDIO_EXTENSIONS:
        return "audio"
    return "image"  # Default


async def validate_upload_file(file: UploadFile) -> tuple[bytes, str, str, int]:
    """Validate an uploaded file completely.

    Args:
        file: FastAPI UploadFile object

    Returns:
        Tuple of (file_bytes, filename, mime_type, file_size)

    Raises:
        HTTPException: If validation fails
    """
    try:
        # Validate filename exists
        if not file.filename:
            raise FileValidationError("Filename is required")

        filename = file.filename

        # Validate extension
        validate_file_extension(filename)

        # Validate MIME type
        mime_type = validate_mime_type(file.content_type, filename)

        # Read file content
        content = await file.read()
        file_size = len(content)

        # Validate size
        validate_file_size(file_size)

        return content, filename, mime_type, file_size

    except FileValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": e.message, "field": e.field},
        )


def validate_image_content(content: bytes) -> bool:
    """Validate that content is actually an image.

    Checks magic bytes to verify file is a valid image format.

    Args:
        content: File content bytes

    Returns:
        True if valid image

    Raises:
        FileValidationError: If not a valid image
    """
    # Magic bytes for common image formats
    magic_bytes = {
        b"\xff\xd8\xff": "JPEG",
        b"\x89PNG\r\n\x1a\n": "PNG",
        b"GIF87a": "GIF",
        b"GIF89a": "GIF",
        b"RIFF": "WEBP",  # WEBP starts with RIFF....WEBP
        b"<svg": "SVG",
        b"<?xml": "SVG",  # SVG with XML declaration
    }

    for magic in magic_bytes:
        if content.startswith(magic):
            return True

    # Check for WEBP specifically (RIFF....WEBP)
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return True

    raise FileValidationError("File content does not match a valid image format")


def sanitize_filename(filename: str) -> str:
    """Sanitize filename for safe storage.

    Removes path components and dangerous characters.

    Args:
        filename: Original filename

    Returns:
        Sanitized filename
    """
    # Get just the filename, not any path
    name = Path(filename).name

    # Replace spaces with underscores
    name = name.replace(" ", "_")

    # Remove any characters that could be dangerous
    allowed_chars = set(
        "abcdefghijklmnopqrstuvwxyz"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "0123456789"
        "-_."
    )
    name = "".join(c for c in name if c in allowed_chars)

    # Ensure we still have a valid filename
    if not name or name.startswith("."):
        name = "file" + name

    return name
