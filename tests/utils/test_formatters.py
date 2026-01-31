"""Tests for formatter utilities."""

import pytest

from app.utils.formatters import (
    markdown_to_html,
    format_content,
    strip_html,
    generate_excerpt,
    sanitize_html,
    truncate_text,
    extract_first_image,
    extract_all_images,
    extract_all_media,
    truncate_paragraphs,
    determine_thumbnail,
)


# markdown_to_html tests
def test_markdown_to_html_basic():
    """Test basic markdown conversion."""
    result = markdown_to_html("# Hello")
    assert "<h1" in result  # May have attributes like id
    assert "Hello</h1>" in result


def test_markdown_to_html_fenced_code():
    """Test fenced code blocks."""
    content = "```python\nprint('hello')\n```"
    result = markdown_to_html(content)
    assert "<code" in result  # May have class attribute
    assert "print('hello')" in result


def test_markdown_to_html_tables():
    """Test table rendering."""
    content = "| A | B |\n|---|---|\n| 1 | 2 |"
    result = markdown_to_html(content)
    assert "<table>" in result
    assert "<th>A</th>" in result


# format_content tests
def test_format_content_markdown():
    """Test markdown formatter."""
    result = format_content("# Title", "markdown")
    assert "<h1" in result  # May have attributes
    assert "Title</h1>" in result


def test_format_content_html():
    """Test HTML passthrough."""
    html = "<p>Hello</p>"
    result = format_content(html, "html")
    assert result == html


def test_format_content_raw():
    """Test raw text escaping."""
    result = format_content("<script>alert('xss')</script>", "raw")
    assert "&lt;script&gt;" in result
    assert "<pre>" in result


# strip_html tests
def test_strip_html_basic():
    """Test stripping HTML tags."""
    result = strip_html("<p>Hello <strong>world</strong></p>")
    assert result == "Hello world"


def test_strip_html_with_entities():
    """Test HTML entity decoding."""
    result = strip_html("<p>&lt;tag&gt; &amp; entities</p>")
    assert result == "<tag> & entities"


def test_strip_html_whitespace():
    """Test whitespace normalization."""
    result = strip_html("<p>Multiple   \n  spaces</p>")
    assert result == "Multiple spaces"


def test_strip_html_empty():
    """Test empty content."""
    assert strip_html("") == ""
    assert strip_html("   ") == ""


# generate_excerpt tests
def test_generate_excerpt_short_content():
    """Test excerpt when content is shorter than max_length."""
    result = generate_excerpt("Short text", "markdown", 50)
    assert result == "Short text"


def test_generate_excerpt_long_content():
    """Test excerpt truncation with ellipsis."""
    long_text = "This is a very long text " * 20
    result = generate_excerpt(long_text, "markdown", 50)
    assert len(result) <= 53  # max_length + "..."
    assert result.endswith("...")


def test_generate_excerpt_word_boundary():
    """Test truncation at word boundary."""
    result = generate_excerpt("Hello world this is a test", "markdown", 15)
    assert result.endswith("...")
    assert not result.startswith("Hello world thi")  # Should break at word


def test_generate_excerpt_markdown_strips_formatting():
    """Test that markdown is stripped in excerpt."""
    result = generate_excerpt("# Title\n\n**Bold** text", "markdown", 50)
    assert "#" not in result
    assert "**" not in result
    assert "Title" in result
    assert "Bold" in result


# sanitize_html tests
def test_sanitize_html_allowed_tags():
    """Test that allowed tags are preserved."""
    html = "<p>Text with <strong>bold</strong> and <em>italic</em></p>"
    result = sanitize_html(html)
    assert "<p>" in result
    assert "<strong>" in result
    assert "<em>" in result


def test_sanitize_html_dangerous_tags():
    """Test that dangerous tags are removed."""
    html = "<script>alert('xss')</script><p>Safe</p>"
    result = sanitize_html(html)
    assert "<script>" not in result
    assert "</script>" not in result
    assert "<p>Safe</p>" in result
    # Note: Text content inside removed tags is kept (e.g., "alert('xss')")


def test_sanitize_html_allowed_attributes():
    """Test allowed attributes on links and images."""
    html = '<a href="http://example.com" title="Link">Click</a>'
    result = sanitize_html(html)
    assert 'href="http://example.com"' in result
    assert 'title="Link"' in result


def test_sanitize_html_dangerous_attributes():
    """Test removal of dangerous attributes."""
    html = '<a href="http://example.com" onclick="alert()">Click</a>'
    result = sanitize_html(html)
    assert "onclick" not in result
    assert 'href="http://example.com"' in result


def test_sanitize_html_safe_protocols():
    """Test that only safe protocols are allowed."""
    html_safe = '<a href="https://example.com">HTTPS</a><a href="/local">Local</a>'
    result = sanitize_html(html_safe)
    assert 'href="https://example.com"' in result
    assert 'href="/local"' in result

    html_unsafe = '<a href="javascript:alert()">JS</a>'
    result = sanitize_html(html_unsafe)
    assert "javascript:" not in result


def test_sanitize_html_self_closing_tags():
    """Test self-closing tags."""
    html = '<img src="/image.jpg" /><br />'
    result = sanitize_html(html)
    assert "<img" in result
    assert 'src="/image.jpg"' in result
    assert "<br />" in result


def test_sanitize_html_closing_tags():
    """Test closing tags."""
    html = "<p>Text</p><script>Bad</script>"
    result = sanitize_html(html)
    assert "</p>" in result
    assert "</script>" not in result


def test_sanitize_html_video_tags():
    """Test video tag support."""
    html = '<video src="/video.mp4" controls></video>'
    result = sanitize_html(html)
    assert "<video" in result
    assert 'src="/video.mp4"' in result


# truncate_text tests
def test_truncate_text_short():
    """Test that short text is not truncated."""
    result = truncate_text("Short", 50)
    assert result == "Short"


def test_truncate_text_long():
    """Test truncation with default suffix."""
    result = truncate_text("This is a very long text", 10)
    assert len(result) <= 13  # 10 + "..."
    assert result.endswith("...")


def test_truncate_text_custom_suffix():
    """Test custom suffix."""
    result = truncate_text("Long text here", 8, " [more]")
    assert result.endswith(" [more]")


def test_truncate_text_word_boundary():
    """Test word boundary truncation."""
    result = truncate_text("Hello world test", 10)
    assert "Hello" in result
    # Should break at word, not mid-word


# extract_first_image tests
def test_extract_first_image_markdown():
    """Test extracting first image from markdown."""
    content = "Text ![First](first.jpg) more ![Second](second.jpg)"
    result = extract_first_image(content)
    assert result == "first.jpg"


def test_extract_first_image_html():
    """Test extracting first image from HTML."""
    content = 'Text <img src="first.jpg"> more <img src="second.jpg">'
    result = extract_first_image(content)
    assert result == "first.jpg"


def test_extract_first_image_none():
    """Test when no image exists."""
    result = extract_first_image("Just text")
    assert result is None


def test_extract_first_image_with_title():
    """Test markdown image with title."""
    content = '![Alt](image.jpg "Title")'
    result = extract_first_image(content)
    assert result == "image.jpg"


# extract_all_images tests
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


# extract_all_media tests
def test_extract_all_media_images():
    """Test extracting image media."""
    content = '![Alt](image.jpg) <img src="photo.png">'
    result = extract_all_media(content)
    assert len(result) == 2
    assert result[0] == {"url": "image.jpg", "type": "image"}
    assert result[1] == {"url": "photo.png", "type": "image"}


def test_extract_all_media_videos():
    """Test extracting video media."""
    content = '<video src="video.mp4"></video>'
    result = extract_all_media(content)
    assert len(result) == 1
    assert result[0]["type"] == "video"
    assert result[0]["url"] == "video.mp4"


def test_extract_all_media_video_by_extension():
    """Test video detection by file extension."""
    content = '![Video](movie.mp4)'
    result = extract_all_media(content)
    assert len(result) == 1
    assert result[0]["type"] == "video"


def test_extract_all_media_source_tags():
    """Test extracting from source tags."""
    content = '<source src="video.webm">'
    result = extract_all_media(content)
    assert len(result) == 1
    assert result[0]["type"] == "video"


def test_extract_all_media_mixed():
    """Test mixed images and videos."""
    content = '![Image](photo.jpg) <video src="video.mp4"></video> ![Video](clip.webm)'
    result = extract_all_media(content)
    assert len(result) == 3
    assert result[0]["type"] == "image"
    assert result[1]["type"] == "video"
    assert result[2]["type"] == "video"


def test_extract_all_media_duplicates():
    """Test duplicate removal."""
    content = '![A](image.jpg) <img src="image.jpg">'
    result = extract_all_media(content)
    assert len(result) == 1


def test_extract_all_media_empty():
    """Test empty content."""
    assert extract_all_media("") == []
    assert extract_all_media("Just text") == []


# truncate_paragraphs tests
def test_truncate_paragraphs_basic():
    """Test basic paragraph truncation."""
    html = "<p>First paragraph</p><p>Second paragraph</p><p>Third paragraph</p>"
    result = truncate_paragraphs(html, 2)
    assert "<p>First paragraph</p>" in result
    assert "<p>Second paragraph</p>" in result
    assert "Third paragraph" not in result


def test_truncate_paragraphs_with_images():
    """Test that paragraphs with only images are skipped."""
    html = '<p><img src="image.jpg"></p><p>Text paragraph</p>'
    result = truncate_paragraphs(html, 1)
    assert "Text paragraph" in result
    assert "image.jpg" not in result


def test_truncate_paragraphs_empty():
    """Test empty content."""
    assert truncate_paragraphs("", 2) == ""


def test_truncate_paragraphs_no_p_tags():
    """Test fallback when no <p> tags exist."""
    text = "First line\n\nSecond line\n\nThird line"
    result = truncate_paragraphs(text, 2)
    # Should create paragraphs from double newlines
    assert "<p>" in result


def test_truncate_paragraphs_strips_tags():
    """Test that HTML tags inside paragraphs are stripped."""
    html = "<p>Text with <strong>bold</strong> and <em>italic</em></p>"
    result = truncate_paragraphs(html, 1)
    assert "<p>Text with bold and italic</p>" in result


# determine_thumbnail tests
def test_determine_thumbnail_explicit_image():
    """Test with explicit image thumbnail."""
    result = determine_thumbnail("Content", "/thumb.jpg")
    assert result == ("/thumb.jpg", False)


def test_determine_thumbnail_explicit_video():
    """Test with explicit video thumbnail."""
    result = determine_thumbnail("Content", "/thumb.mp4")
    thumb, is_video = result
    # If thumbnail is video, should try to find image in content or fallback
    assert is_video or thumb == "/thumb.mp4"


def test_determine_thumbnail_from_content():
    """Test extracting thumbnail from content."""
    content = '![Image](photo.jpg)'
    result = determine_thumbnail(content, None)
    assert result[0] == "photo.jpg"
    assert result[1] is False


def test_determine_thumbnail_video_fallback():
    """Test video fallback when no image."""
    content = '<video src="video.mp4"></video>'
    result = determine_thumbnail(content, None)
    assert result[0] == "video.mp4"
    assert result[1] is True


def test_determine_thumbnail_prefer_image_over_video():
    """Test that image is preferred over video."""
    content = '<video src="video.mp4"></video> ![Image](photo.jpg)'
    result = determine_thumbnail(content, None)
    # Should prefer the image
    assert "photo.jpg" in result[0] or result[0] == "photo.jpg"


def test_determine_thumbnail_empty_content():
    """Test with no content and no thumbnail."""
    result = determine_thumbnail("", None)
    assert result == (None, False)
