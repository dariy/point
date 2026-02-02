"""Media model for file uploads.

Stores metadata for uploaded images, videos, and audio files.
"""

from datetime import UTC, datetime
from enum import Enum as PyEnum

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class FileType(str, PyEnum):
    """Supported file types."""

    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"


class Media(Base):
    """Media file model.

    Attributes:
        id: Primary key
        filename: Original filename
        original_path: Path to original file
        thumbnail_path: Path to generated thumbnail (images only)
        file_type: Type of file (image, video, audio)
        mime_type: MIME type of the file
        file_size: File size in bytes
        width: Image/video width in pixels
        height: Image/video height in pixels
        post_id: Optional link to a post
        uploaded_at: Upload timestamp
        checksum: SHA256 hash for deduplication
        alt_text: Alternative text for accessibility
        caption: Optional caption/description
    """

    __tablename__ = "media"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    original_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    thumbnail_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    file_type: Mapped[FileType] = mapped_column(Enum(FileType), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    post_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("posts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.now(UTC), nullable=False, index=True
    )
    checksum: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True, unique=True
    )
    alt_text: Mapped[str | None] = mapped_column(String(500), nullable=True)
    caption: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    # Relationships
    post: Mapped["Post | None"] = relationship("Post", lazy="selectin")

    def __repr__(self) -> str:
        return f"<Media(id={self.id}, filename='{self.filename}', type='{self.file_type.value}')>"

    @property
    def is_image(self) -> bool:
        """Check if file is an image."""
        return self.file_type == FileType.IMAGE

    @property
    def is_video(self) -> bool:
        """Check if file is a video."""
        return self.file_type == FileType.VIDEO

    @property
    def is_audio(self) -> bool:
        """Check if file is audio."""
        return self.file_type == FileType.AUDIO

    @property
    def has_thumbnail(self) -> bool:
        """Check if thumbnail exists."""
        return self.thumbnail_path is not None

    @property
    def dimensions(self) -> tuple[int, int] | None:
        """Get file dimensions as tuple."""
        if self.width is not None and self.height is not None:
            return (self.width, self.height)
        return None

    @property
    def is_orphaned(self) -> bool:
        """Check if media is not linked to any post."""
        return self.post_id is None


# Import for relationship (avoid circular import)
from app.models.post import Post  # noqa: E402, F401
