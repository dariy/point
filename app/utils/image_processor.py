"""Image processing utilities.

Handles thumbnail generation, image resizing, and optimization.
"""

import hashlib
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from app.config import get_settings


class ImageProcessor:
    """Processor for image manipulation operations."""

    def __init__(
        self,
        max_width: int | None = None,
        thumbnail_size: tuple[int, int] | None = None,
        jpeg_quality: int | None = None,
    ):
        """Initialize image processor.

        Args:
            max_width: Maximum image width (resizes if larger)
            thumbnail_size: Thumbnail dimensions (width, height)
            jpeg_quality: JPEG compression quality (1-100)
        """
        settings = get_settings()
        self.max_width = max_width or settings.max_image_width
        self.thumbnail_size = thumbnail_size or settings.thumbnail_size
        self.jpeg_quality = jpeg_quality or settings.jpeg_quality

    def process_image(
        self,
        image_data: bytes,
        resize: bool = True,
        progressive: bool = True,
    ) -> tuple[bytes, int, int, str]:
        """Process an image: resize if needed and optimize.

        Args:
            image_data: Raw image bytes
            resize: Whether to resize if larger than max_width
            progressive: Whether to save as progressive JPEG

        Returns:
            Tuple of (processed_bytes, width, height, format)
        """
        img: Image.Image = Image.open(BytesIO(image_data))
        original_format = img.format or "JPEG"
        output_format = original_format

        # Convert RGBA to RGB for JPEG
        if img.mode == "RGBA" and output_format == "JPEG":
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3])
            img = background
        elif img.mode not in ("RGB", "L", "P"):
            img = img.convert("RGB")

        # Resize if larger than max width
        if resize and img.width > self.max_width:
            ratio = self.max_width / img.width
            new_height = int(img.height * ratio)
            img = img.resize((self.max_width, new_height), Image.Resampling.LANCZOS)

        # Save with optimization
        output = BytesIO()
        save_kwargs = self._get_save_kwargs(output_format, progressive)
        img.save(output, format=output_format, **save_kwargs)
        output.seek(0)

        return output.read(), img.width, img.height, output_format

    def generate_thumbnail(
        self,
        image_data: bytes,
        size: tuple[int, int] | None = None,
    ) -> tuple[bytes, int, int]:
        """Generate a thumbnail from image data.

        Args:
            image_data: Raw image bytes
            size: Thumbnail dimensions (width, height), defaults to config

        Returns:
            Tuple of (thumbnail_bytes, width, height)
        """
        size = size or self.thumbnail_size
        img: Image.Image = Image.open(BytesIO(image_data))

        # Convert mode if needed
        if img.mode == "RGBA":
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3])
            img = background
        elif img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # Use thumbnail method (maintains aspect ratio)
        img.thumbnail(size, Image.Resampling.LANCZOS)

        # Save as JPEG
        output = BytesIO()
        img.save(
            output,
            format="JPEG",
            quality=self.jpeg_quality,
            optimize=True,
            progressive=True,
        )
        output.seek(0)

        return output.read(), img.width, img.height

    def get_image_dimensions(self, image_data: bytes) -> tuple[int, int]:
        """Get image dimensions without full processing.

        Args:
            image_data: Raw image bytes

        Returns:
            Tuple of (width, height)
        """
        img = Image.open(BytesIO(image_data))
        return img.width, img.height

    def _get_save_kwargs(self, format: str, progressive: bool) -> dict[str, Any]:
        """Get format-specific save kwargs.

        Args:
            format: Image format (JPEG, PNG, etc.)
            progressive: Whether to use progressive encoding

        Returns:
            Dictionary of save kwargs
        """
        format_upper = format.upper()
        kwargs: dict[str, Any] = {"optimize": True}

        if format_upper in ("JPEG", "JPG"):
            kwargs["quality"] = self.jpeg_quality
            if progressive:
                kwargs["progressive"] = True
        elif format_upper == "PNG":
            kwargs["compress_level"] = 6
        elif format_upper == "WEBP":
            kwargs["quality"] = self.jpeg_quality
            kwargs["method"] = 4

        return kwargs


def calculate_checksum(data: bytes) -> str:
    """Calculate SHA256 checksum of data.

    Args:
        data: Bytes to hash

    Returns:
        Hex string of SHA256 hash
    """
    return hashlib.sha256(data).hexdigest()


def get_file_type_from_mime(mime_type: str) -> str:
    """Determine file type category from MIME type.

    Args:
        mime_type: MIME type string

    Returns:
        File type: 'image', 'video', or 'audio'
    """
    if mime_type.startswith("image/"):
        return "image"
    elif mime_type.startswith("video/"):
        return "video"
    elif mime_type.startswith("audio/"):
        return "audio"
    return "image"  # Default


def is_image_mime(mime_type: str) -> bool:
    """Check if MIME type is for an image.

    Args:
        mime_type: MIME type string

    Returns:
        True if image MIME type
    """
    return mime_type.startswith("image/")


def generate_storage_path(
    base_path: str | Path,
    filename: str,
    year: int,
    month: int,
) -> Path:
    """Generate date-based storage path.

    Args:
        base_path: Base storage directory
        filename: Original filename
        year: Year for directory
        month: Month for directory

    Returns:
        Full path for file storage
    """
    base = Path(base_path)
    return base / str(year) / f"{month:02d}" / filename


def ensure_directory(path: Path) -> None:
    """Ensure directory exists, create if not.

    Args:
        path: Directory path to ensure exists
    """
    path.mkdir(parents=True, exist_ok=True)
