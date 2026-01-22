"""Post model for blog content.

Stores blog posts with support for drafts, publishing, and custom URLs.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class PostStatus(str, PyEnum):
    """Post publication status."""

    DRAFT = "draft"
    PUBLISHED = "published"
    HIDDEN = "hidden"


class PostFormatter(str, PyEnum):
    """Content formatter type."""

    MARKDOWN = "markdown"
    HTML = "html"
    RAW = "raw"


class Post(Base):
    """Blog post model.

    Attributes:
        id: Primary key
        title: Post title
        slug: URL-friendly unique identifier
        content: Post content (markdown, html, or raw)
        excerpt: Short summary (auto-generated or manual)
        formatter: Content formatter type
        status: Publication status (draft, published, hidden)
        is_featured: Whether post is featured
        view_count: Number of views
        published_at: Publication timestamp
        created_at: Creation timestamp
        updated_at: Last update timestamp
        author_id: Foreign key to User
        thumbnail_path: Path to thumbnail image
        custom_url: Optional custom URL alias
        meta_description: SEO meta description
        preview_token: Token for draft preview access
        preview_expires_at: Preview token expiration
    """

    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    slug: Mapped[str] = mapped_column(
        String(200), unique=True, index=True, nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    formatter: Mapped[str] = mapped_column(
        Enum(PostFormatter), default=PostFormatter.MARKDOWN, nullable=False
    )
    status: Mapped[str] = mapped_column(
        Enum(PostStatus), default=PostStatus.DRAFT, index=True, nullable=False
    )
    is_featured: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    view_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )
    author_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    thumbnail_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    custom_url: Mapped[str | None] = mapped_column(
        String(200), unique=True, nullable=True
    )
    meta_description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    preview_token: Mapped[str | None] = mapped_column(
        String(64), unique=True, nullable=True, index=True
    )
    preview_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    author: Mapped["User"] = relationship("User", lazy="selectin")

    def __repr__(self) -> str:
        return f"<Post(id={self.id}, title='{self.title}', status='{self.status}')>"

    @property
    def is_published(self) -> bool:
        """Check if post is published."""
        return self.status == PostStatus.PUBLISHED

    @property
    def is_draft(self) -> bool:
        """Check if post is a draft."""
        return self.status == PostStatus.DRAFT

    @property
    def is_hidden(self) -> bool:
        """Check if post is hidden."""
        return self.status == PostStatus.HIDDEN

    @property
    def preview_is_valid(self) -> bool:
        """Check if preview token is still valid."""
        if not self.preview_token or not self.preview_expires_at:
            return False
        return datetime.utcnow() < self.preview_expires_at.replace(tzinfo=None)


# Import for relationship (avoid circular import)
from app.models.user import User  # noqa: E402, F401
