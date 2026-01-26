import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.models.user import User
from app.models.post_tag import post_tags
from datetime import datetime

@pytest.mark.asyncio
async def test_tag_cloud_on_single_post(
    client: AsyncClient,
    db: AsyncSession,
):
    # Create a user
    user = User(
        username="testauthor",
        email="testauthor@example.com",
        password_hash="hash",
        display_name="Test Author"
    )
    db.add(user)
    await db.flush()

    # Create a tag (must be featured for tag cloud)
    tag = Tag(name="Test Tag Cloud", slug="test-tag-cloud", is_featured=True)
    db.add(tag)
    await db.flush()

    # Create a post with the tag
    post = Post(
        title="Test Post Cloud",
        slug="test-post-cloud",
        content="Content",
        status=PostStatus.PUBLISHED,
        published_at=datetime.now(),
        author_id=user.id
    )
    db.add(post)
    await db.flush()

    # Link tag to post
    await db.execute(
        post_tags.insert().values(post_id=post.id, tag_id=tag.id)
    )
    await db.commit()
    
    # Refresh stats
    tag.post_count = 1
    await db.commit()

    # Fetch single post page
    response = await client.get(f"/posts/{post.slug}")
    assert response.status_code == 200
    
    # Check if tag cloud container is present
    assert 'class="tag-cloud footer-tags"' in response.text
    assert 'Test Tag Cloud' in response.text

@pytest.mark.asyncio
async def test_tag_cloud_on_gallery(
    client: AsyncClient,
    db: AsyncSession,
):
    # Create a tag (must be featured)
    tag = Tag(name="Gallery Tag", slug="gallery-tag", is_featured=True)
    db.add(tag)
    await db.flush()
    
    tag.post_count = 1
    await db.commit()

    # Fetch gallery page
    response = await client.get("/gallery")
    assert response.status_code == 200
    
    # Check if tag cloud container is present
    assert 'class="tag-cloud footer-tags"' in response.text
    assert 'Gallery Tag' in response.text
