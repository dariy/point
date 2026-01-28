
import pytest
from app.models.post import Post, PostStatus, PostFormatter
from datetime import datetime, timedelta

@pytest.mark.asyncio
async def test_reproduce_carousel_nav(client, db, test_user):
    # Create 3 posts
    now = datetime.now()
    author_id = test_user["user"].id
    
    post1 = Post(
        title="Post 1",
        slug="post-1",
        content="Content 1",
        status=PostStatus.PUBLISHED,
        published_at=now - timedelta(days=2),
        created_at=now - timedelta(days=2),
        author_id=author_id,
        formatter=PostFormatter.MARKDOWN
    )
    
    # Post 2 has media (carousel) - effectively no text content if we strip html?
    # Actually, the logic is: "Check if post has text content (ignoring images and whitespace)"
    # If I provide content with just images, it triggers immersive layout.
    post2 = Post(
        title="Post 2",
        slug="post-2",
        content="![Image 1](image1.jpg)\n![Image 2](image2.jpg)", # Markdown images
        status=PostStatus.PUBLISHED,
        published_at=now - timedelta(days=1),
        created_at=now - timedelta(days=1),
        formatter=PostFormatter.MARKDOWN,
        author_id=author_id
    )
    
    post3 = Post(
        title="Post 3",
        slug="post-3",
        content="Content 3",
        status=PostStatus.PUBLISHED,
        published_at=now,
        created_at=now,
        author_id=author_id,
        formatter=PostFormatter.MARKDOWN
    )
    
    db.add_all([post1, post2, post3])
    await db.commit()
    
    # Request Post 2 page
    response = await client.get("/posts/post-2")
    assert response.status_code == 200
    html = response.text
    
    print("\n--- HTML Content Check ---")
    
    # Check if immersive layout is active
    if "immersive-layout" in html:
        print("Immersive layout is ACTIVE")
    else:
        print("Immersive layout is NOT ACTIVE")
        
    # Check if carousel structure is present (requires specific parsing or just string check)
    if "carousel-container" in html:
        print("Carousel container FOUND")
    else:
        print("Carousel container NOT FOUND")
        
    # Check for our data element
    if 'id="post-nav-data"' in html:
        print("Data element FOUND")
    else:
        print("Data element NOT FOUND")
        
    if 'data-prev-url="/posts/post-1"' in html:
        print("Prev URL Correct")
    else:
        print("Prev URL Missing/Incorrect")
        
    if 'data-next-url="/posts/post-3"' in html:
        print("Next URL Correct")
    else:
        print("Next URL Missing/Incorrect")

    # Print the data element if found
    import re
    data_match = re.search(r'<div id="post-nav-data".*?>\s*</div>', html, re.DOTALL)
    if data_match:
        print("\n--- Data Element Content ---")
        print(data_match.group(0))
    else:
        print("\n--- Data Element Not Matched by Regex ---")
