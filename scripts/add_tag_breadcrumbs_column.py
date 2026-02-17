import asyncio
import sys
from pathlib import Path

from sqlalchemy import text

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy.ext.asyncio import create_async_engine

# Use point.db explicitly as confirmed by directory listing
DATABASE_URL = "sqlite+aiosqlite:///./data/point.db"
engine = create_async_engine(DATABASE_URL)


async def add_column():
    print("Adding include_in_breadcrumbs column to tags table...")
    async with engine.begin() as conn:
        try:
            await conn.execute(text("ALTER TABLE tags ADD COLUMN include_in_breadcrumbs BOOLEAN DEFAULT TRUE NOT NULL"))
            print("include_in_breadcrumbs column added successfully.")
        except Exception as e:
            if "duplicate column name" in str(e).lower() or "already exists" in str(e).lower():
                 print("include_in_breadcrumbs column already exists.")
            else:
                 print(f"Error adding include_in_breadcrumbs column: {e}")

        # Update existing records to TRUE (though DEFAULT TRUE should handle it, being explicit is safe)
        try:
            await conn.execute(text("UPDATE tags SET include_in_breadcrumbs = TRUE WHERE include_in_breadcrumbs IS NULL"))
            print("Updated existing records.")
        except Exception as e:
            print(f"Error updating existing records: {e}")

async def main():
    await add_column()
    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(main())
