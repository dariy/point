import asyncio
import sys
from pathlib import Path

from sqlalchemy import text

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import engine


async def add_column():
    print("Adding is_featured column to tags table...")
    async with engine.begin() as conn:
        try:
            await conn.execute(text("ALTER TABLE tags ADD COLUMN is_featured BOOLEAN DEFAULT FALSE"))
            print("Column added successfully.")
        except Exception as e:
            if "duplicate column" in str(e).lower() or "no such table" in str(e).lower():
                 print(f"Skipping: {e}")
            else:
                 print(f"Error adding column: {e}")
                 # For SQLite specifically, if it fails, we might need a more complex approach
                 # but ADD COLUMN is supported in newer SQLite.
                 # If it fails, I'll know.

async def main():
    await add_column()
    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(main())
