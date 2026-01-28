import pytest
from datetime import datetime
from app.models.post import Post, PostStatus, PostFormatter

@pytest.mark.asyncio
async def test_single_post_ajax(client, db, test_user):
    """Test fetching a single post via AJAX returns JSON."""
    # Create a post
    post = Post(
        title="AJAX Test Post",
        slug="ajax-test-post",
        content="<p>Test Content</p>",
        status=PostStatus.PUBLISHED,
        published_at=datetime.utcnow(),
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id
    )
    db.add(post)
    await db.commit()
    
    # Request with AJAX header
    response = await client.get(
        f"/posts/{post.slug}",
        headers={"X-Requested-With": "XMLHttpRequest"}
    )
    
    assert response.status_code == 200
    assert "application/json" in response.headers["content-type"]
    
    data = response.json()
    
    # Verify structure
    assert "post" in data
    assert data["post"]["title"] == "AJAX Test Post"
    assert data["post"]["slug"] == "ajax-test-post"
    assert "content_html" in data["post"]
    
    assert "has_text_content" in data
    assert data["has_text_content"] is True
    
    assert "post_media" in data
    assert isinstance(data["post_media"], list)
    
    assert "blog_settings" in data
    assert "blog_title" in data

@pytest.mark.asyncio
async def test_single_post_immersive_ajax(client, db, test_user):
    """Test fetching a media-only post via AJAX returns JSON with correct flags."""
    # Create a post with only image, no text
    post = Post(
        title="Immersive Post",
        slug="immersive-post",
        content="![Image](test.jpg)",
        status=PostStatus.PUBLISHED,
        published_at=datetime.utcnow(),
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id
    )
    db.add(post)
    await db.commit()
    
    # Request with AJAX header
    response = await client.get(
        f"/posts/{post.slug}",
        headers={"X-Requested-With": "XMLHttpRequest"}
    )
    
    assert response.status_code == 200
    data = response.json()
    
    # has_text_content should be False (or True if my formatter logic considers the image tag as content, 
    # but the logic uses strip_html to check for text)
    # The format_content utility converts markdown to HTML.
    # strip_html removes tags.
    # "![Image](test.jpg)" -> <img src...> -> strip_html -> "" -> False.
    
    # Wait, format_content might wrap it in <p>?
    # If it is just an image, markdown might wrap in <p>.
    # <p><img ...></p> -> strip_html -> "" (empty).
    
    # Let's verify expectations based on implementation.
    # If implementation is correct, has_text_content should be False.
    
    assert data["post"]["title"] == "Immersive Post"
    # Note: Depending on implementation details of strip_html and formatters, 
    # this might be tricky, but let's assume standard behavior.
    assert data["has_text_content"] is False
    assert len(data["post_media"]) > 0
