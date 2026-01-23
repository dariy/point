"""PostTag association table for many-to-many relationship.

Links posts to tags in a many-to-many relationship.
"""

from sqlalchemy import Column, ForeignKey, Integer, Table

from app.database import Base

# Association table for many-to-many relationship between posts and tags
post_tags = Table(
    "post_tags",
    Base.metadata,
    Column("post_id", Integer, ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)
