"""TagLocation model for storing coordinates associated with tags.

Allows one tag to have multiple geographical locations.
"""

from typing import TYPE_CHECKING

from sqlalchemy import Float, ForeignKey, Integer
from sqlalchemy.ext.asyncio import AsyncAttrs
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.tag import Tag


class TagLocation(AsyncAttrs, Base):
    """Geographical location associated with a tag.

    Attributes:
        id: Primary key
        tag_id: Foreign key to tags table
        latitude: Latitude coordinate
        longitude: Longitude coordinate
    """

    __tablename__ = "tag_locations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tags.id", ondelete="CASCADE"), nullable=False, index=True
    )
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)

    # Relationship back to tag
    tag: Mapped["Tag"] = relationship("Tag", back_populates="locations")

    def __repr__(self) -> str:
        return f"<TagLocation(id={self.id}, tag_id={self.tag_id}, lat={self.latitude}, lng={self.longitude})>"
