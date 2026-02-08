
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import UTC, datetime, timedelta

from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag

@pytest.mark.asyncio
async def test_post_with_hierarchical_tags(client: AsyncClient, db: AsyncSession, test_user):
    # Create parent tag
    parent = Tag(name="Parent", slug="parent")
    db.add(parent)
    await db.commit()
    
    # Create child tag
    child = Tag(name="Child", slug="child")
    child.parents.append(parent)
    db.add(child)
    await db.commit()
    
    # Create post with child tag
    post = Post(
        title="Hierarchy Post",
        slug="hierarchy-post",
        content="Testing hierarchy.",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.now(UTC),
        author_id=test_user["user"].id,
    )
    post.tags.append(child)
    db.add(post)
    await db.commit()
    
    # Try to access post page
    response = await client.get("/posts/hierarchy-post")
    assert response.status_code == 200
    assert "Hierarchy Post" in response.text
    assert "Child" in response.text
    # Parent might not be visible depending on implementation, but accessing it should not crash
