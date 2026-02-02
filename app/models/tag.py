"""Tag model for categorizing posts.

Stores tags with support for descriptions, custom URLs, and importance marking.
"""

from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Tag(Base):
    """Tag model for categorizing posts.

    Attributes:
        id: Primary key
        name: Tag display name (unique)
        slug: URL-friendly identifier (unique)
        description: Optional tag description
        custom_url: Optional custom URL for tag page
        is_important: Whether tag appears in tag cloud
        post_count: Denormalized count of posts with this tag
        created_at: Creation timestamp
    """

    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(
        String(100), unique=True, index=True, nullable=False
    )
    slug: Mapped[str] = mapped_column(
        String(100), unique=True, index=True, nullable=False
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    custom_url: Mapped[str | None] = mapped_column(String(200), nullable=True)
    is_important: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_featured: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    post_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )

    # Relationship to posts through association table
    posts: Mapped[list["Post"]] = relationship(
        "Post",
        secondary="post_tags",
        back_populates="tags",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Tag(id={self.id}, name='{self.name}', post_count={self.post_count})>"

    @property
    def url(self) -> str:
        """Get the URL for this tag."""
        return self.custom_url or f"/tag/{self.slug}"


# Import for relationship (avoid circular import)
from app.models.post import Post  # noqa: E402, F401
