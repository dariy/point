"""Add sort_order column to tags table.

Allows manual ordering of top-level tags in the header-tags-bar.
Tags with sort_order set appear first (ascending), then unordered tags alphabetically.
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def upgrade(session: AsyncSession) -> None:
    """Add sort_order column to tags table."""
    try:
        await session.execute(text("ALTER TABLE tags ADD COLUMN sort_order INTEGER"))
        logger.info("Added sort_order column to tags table.")
    except Exception as e:
        if "duplicate column" in str(e).lower() or "already exists" in str(e).lower():
            logger.info("sort_order column already exists in tags table, skipping.")
        else:
            raise
    await session.commit()
