"""Add PAGE status to posts.

Note: SQLite doesn't strictly enforce enums on columns, so this migration
is primarily for documentation and ensuring existing data is consistent.
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def upgrade(session: AsyncSession) -> None:
    """Ensure posts table can handle PAGE status."""
    # In SQLite, the status column is VARCHAR(9)
    # No changes needed to the table structure itself since it's already VARCHAR.

    # We might want to perform data cleanup or initialization here if needed.
    # For now, just a placeholder to mark that the system supports 'page' status.
    logger.info("Posts table is ready for 'page' status.")
    await session.commit()
