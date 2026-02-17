"""Initial feature migrations.

Adds columns for tag features: is_featured, hidden, hierarchy settings, etc.
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def upgrade(session: AsyncSession) -> None:
    """Apply migrations to tags table."""

    # List of columns to add with their SQL definitions
    columns_to_add = [
        ("is_featured", "BOOLEAN DEFAULT FALSE"),
        ("show_related_tags_as_children", "BOOLEAN DEFAULT FALSE NOT NULL"),
        ("is_hidden", "BOOLEAN DEFAULT FALSE NOT NULL"),
        ("is_hidden_posts", "BOOLEAN DEFAULT FALSE NOT NULL"),
        ("include_in_breadcrumbs", "BOOLEAN DEFAULT TRUE NOT NULL"),
    ]

    for col_name, col_def in columns_to_add:
        try:
            # Check if column exists first (SQLite doesn't have IF NOT EXISTS for ADD COLUMN)
            # We can try to add it and catch the error if it exists
            await session.execute(text(f"ALTER TABLE tags ADD COLUMN {col_name} {col_def}"))
            logger.info(f"Added column tags.{col_name}")
        except Exception as e:
            if "duplicate column name" in str(e).lower() or "already exists" in str(e).lower():
                logger.debug(f"Column tags.{col_name} already exists, skipping.")
            else:
                logger.error(f"Error adding column tags.{col_name}: {e}")
                # We don't raise here to allow other columns to be added
                # though usually it means the DB state is consistent with what we want if it fails like this

    await session.commit()
