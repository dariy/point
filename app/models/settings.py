"""Blog settings model.

Stores key-value pairs for application-level configuration.
"""

from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class BlogSettings(Base):
    """Model for storing application settings in key-value pairs.

    Values are stored as strings and converted back to their intended type
    based on the value_type column.
    """

    __tablename__ = "blog_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=True)
    value_type: Mapped[str] = mapped_column(String(20), default="string")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:
        return f"<BlogSettings(key='{self.key}', value_type='{self.value_type}')>"
