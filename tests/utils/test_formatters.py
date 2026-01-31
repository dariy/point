"""Tests for formatter utilities."""

from app.utils.formatters import extract_all_images


def test_extract_all_images_markdown():
    """Test extracting images from Markdown."""
    content = """
    # Title
    
    ![Alt 1](image1.jpg)
    
    Text here.
    
    ![Alt 2](/path/to/image2.png "Title")
    """
    images = extract_all_images(content)
    assert len(images) == 2
    assert "image1.jpg" in images
    assert "/path/to/image2.png" in images


def test_extract_all_images_html():
    """Test extracting images from HTML."""
    content = """
    <h1>Title</h1>
    <p>Text</p>
    <img src="image1.jpg" alt="Alt 1">
    <div class="content">
        <img src='/path/to/image2.png' />
    </div>
    """
    images = extract_all_images(content)
    assert len(images) == 2
    assert "image1.jpg" in images
    assert "/path/to/image2.png" in images


def test_extract_all_images_mixed():
    """Test extracting images from mixed content."""
    content = """
    ![Markdown](md.jpg)
    <img src="html.jpg">
    """
    images = extract_all_images(content)
    assert len(images) == 2
    assert "md.jpg" in images
    assert "html.jpg" in images


def test_extract_all_images_duplicates():
    """Test that duplicates are removed."""
    content = """
    ![Same](image.jpg)
    <img src="image.jpg">
    """
    images = extract_all_images(content)
    assert len(images) == 1
    assert images[0] == "image.jpg"


def test_extract_all_images_empty():
    """Test extracting from empty or text-only content."""
    assert extract_all_images("") == []
    assert extract_all_images("Just text") == []
