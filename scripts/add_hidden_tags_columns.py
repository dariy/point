import asyncio
import sys
from pathlib import Path

from sqlalchemy import text

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import engine


async def add_columns():
    print("Adding is_hidden and is_hidden_posts columns to tags table...")
    async with engine.begin() as conn:
        # Add is_hidden column
        try:
            await conn.execute(text("ALTER TABLE tags ADD COLUMN is_hidden BOOLEAN DEFAULT FALSE NOT NULL"))
            print("is_hidden column added successfully.")
        except Exception as e:
            if "duplicate column name" in str(e).lower():
                 print("is_hidden column already exists.")
            else:
                 print(f"Error adding is_hidden column: {e}")

        # Add is_hidden_posts column
        try:
            await conn.execute(text("ALTER TABLE tags ADD COLUMN is_hidden_posts BOOLEAN DEFAULT FALSE NOT NULL"))
            print("is_hidden_posts column added successfully.")
        except Exception as e:
            if "duplicate column name" in str(e).lower():
                 print("is_hidden_posts column already exists.")
            else:
                 print(f"Error adding is_hidden_posts column: {e}")

async def main():
    await add_columns()
    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(main())
