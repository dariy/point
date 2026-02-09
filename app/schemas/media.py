"""Media schemas for request/response validation.

Defines Pydantic models for media upload and management operations.
"""

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class FileType(StrEnum):
    """Supported file types."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"


class MediaBase(BaseModel):
    """Base media schema with common fields."""

    alt_text: str | None = Field(default=None, max_length=500)
    caption: str | None = Field(default=None, max_length=1000)
    post_id: int | None = Field(default=None, description="Optional post to link to")


class MediaUpdate(BaseModel):
    """Schema for updating media metadata."""

    alt_text: str | None = Field(default=None, max_length=500)
    caption: str | None = Field(default=None, max_length=1000)
    post_id: int | None = Field(default=None)


class MediaRename(BaseModel):
    """Schema for renaming media."""

    new_filename: str = Field(..., min_length=1, max_length=255)


class MediaResponse(BaseModel):
    """Schema for media response."""

    id: int
    filename: str
    original_path: str
    thumbnail_path: str | None
    file_type: FileType
    mime_type: str
    file_size: int
    width: int | None
    height: int | None
    post_id: int | None
    uploaded_at: datetime
    checksum: str
    alt_text: str | None
    caption: str | None

    # Computed fields
    url: str = Field(description="Public URL to the file")
    thumbnail_url: str | None = Field(
        default=None, description="Public URL to thumbnail"
    )

    model_config = ConfigDict(from_attributes=True)


class MediaListItem(BaseModel):
    """Schema for media in list view (lighter response)."""

    id: int
    filename: str
    file_type: FileType
    mime_type: str
    file_size: int
    width: int | None
    height: int | None
    uploaded_at: datetime
    url: str
    thumbnail_url: str | None
    post_id: int | None
    is_orphaned: bool = Field(description="Whether the file is not linked to any post")

    model_config = ConfigDict(from_attributes=True)


class MediaListResponse(BaseModel):
    """Schema for paginated media list response."""

    media: list[MediaListItem]
    total: int
    page: int
    per_page: int
    pages: int


class MediaUploadResponse(BaseModel):
    """Schema for media upload response."""

    id: int
    filename: str
    original_path: str
    url: str
    thumbnail_url: str | None
    file_type: FileType
    file_size: int
    width: int | None
    height: int | None
    checksum: str
    message: str = "File uploaded successfully"


class MultipleMediaUploadResponse(BaseModel):
    """Schema for multiple file upload response."""

    uploaded: list[MediaUploadResponse]
    failed: list[dict[str, Any]] = Field(
        default_factory=list, description="Files that failed to upload"
    )
    total_uploaded: int
    total_failed: int


class StorageStatsResponse(BaseModel):
    """Schema for storage statistics."""

    total_files: int
    total_size_bytes: int
    total_size_mb: float
    quota_bytes: int
    quota_mb: float
    usage_percent: float
    orphaned_files: int
    orphaned_size_bytes: int
    by_type: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Breakdown by file type (image, video, audio)",
    )


class OrphanedMediaResponse(BaseModel):
    """Schema for orphaned media list."""

    media: list[MediaListItem]
    total: int
    total_size_bytes: int


class MediaDeleteResponse(BaseModel):
    """Schema for media deletion response."""

    message: str
    deleted_count: int = 1
    freed_bytes: int


class BulkDeleteResponse(BaseModel):
    """Schema for bulk deletion response."""

    message: str
    deleted_count: int
    failed_count: int
    freed_bytes: int


# Allowed file extensions and MIME types
ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm"}
ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a"}

ALLOWED_IMAGE_MIMES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
}
ALLOWED_VIDEO_MIMES = {
    "video/mp4",
    "video/quicktime",
    "video/webm",
}
ALLOWED_AUDIO_MIMES = {
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
    "audio/x-m4a",
}

ALLOWED_EXTENSIONS = (
    ALLOWED_IMAGE_EXTENSIONS | ALLOWED_VIDEO_EXTENSIONS | ALLOWED_AUDIO_EXTENSIONS
)
ALLOWED_MIMES = ALLOWED_IMAGE_MIMES | ALLOWED_VIDEO_MIMES | ALLOWED_AUDIO_MIMES
