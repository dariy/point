import asyncio
import os
import sys

# Add the current directory to sys.path to import app modules
sys.path.append(os.getcwd())

from sqlalchemy import select

from app.database import SessionLocal
from app.models.post import Post


async def check():
    async with SessionLocal() as db:
        for slug in ["podcast", "author"]:
            result = await db.execute(select(Post).where(Post.slug == slug))
            post = result.scalar_one_or_none()
            if post:
                print(f"Post slug: {post.slug}, status: {post.status}, published_at: {post.published_at}")
            else:
                print(f"Post slug: {slug} not found")

if __name__ == "__main__":
    asyncio.run(check())
