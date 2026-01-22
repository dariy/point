#!/usr/bin/env python3
"""Initialize the database.

Creates all tables and optionally creates an initial admin user.
"""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import create_tables, engine


async def main() -> None:
    """Initialize database tables."""
    print("Creating database tables...")
    await create_tables()
    print("Database initialized successfully!")

    # Close engine
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
