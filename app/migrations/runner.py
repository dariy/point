"""Database migration runner.

Automatically discovers and applies pending migrations.
"""

import importlib.util
import logging
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import engine
from app.models.migration_history import MigrationHistory

logger = logging.getLogger(__name__)


async def run_migrations() -> None:
    """Discover and run all pending migrations."""
    logger.info("Checking for pending database migrations...")

    # Ensure migration_history table exists
    async with engine.begin() as conn:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS migration_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(255) NOT NULL UNIQUE,
                applied_at DATETIME NOT NULL
            )
        """))

    migrations_dir = Path(__file__).parent
    migration_files = sorted([
        f for f in migrations_dir.glob("*.py")
        if f.name.startswith("m_") and f.name.endswith(".py")
    ])

    if not migration_files:
        logger.info("No migration files found.")
        return

    async with AsyncSession(engine) as session:
        # Get applied migrations
        result = await session.execute(select(MigrationHistory.name))
        applied_migrations = {row[0] for row in result.all()}

        for mg_file in migration_files:
            migration_name = mg_file.stem
            if migration_name in applied_migrations:
                continue

            logger.info(f"Applying migration: {migration_name}")
            try:
                # Load and run migration
                spec = importlib.util.spec_from_file_location(migration_name, mg_file)
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)

                    if hasattr(module, "upgrade"):
                        # Run the migration
                        await module.upgrade(session)

                        # Record in history
                        history = MigrationHistory(name=migration_name)
                        session.add(history)
                        await session.commit()
                        logger.info(f"Successfully applied {migration_name}")
                    else:
                        logger.warning(f"Migration {migration_name} has no upgrade() function")
            except Exception as e:
                await session.rollback()
                logger.error(f"Failed to apply migration {migration_name}: {e}")
                raise

    logger.info("Database migrations check complete.")
