"""Additional tests for formatters coverage."""

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

def test_markdown_extensions():
    md = """
| Header |
| ------ |
| Cell   |
"""
    html = markdown_to_html(md)
    assert "<table>" in html

def test_format_content_types():
    assert "<strong>B</strong>" in format_content("**B**", "markdown")
    assert "<b>B</b>" in format_content("<b>B</b>", "html")
    assert "&lt;b&gt;B&lt;/b&gt;" in format_content("<b>B</b>", "raw")

def test_strip_html_entities():
    assert strip_html("A &amp; B") == "A & B"
    assert strip_html("<p>  Space  </p>") == "Space"

def test_generate_excerpt_truncation():
    text = "Word " * 100
    excerpt = generate_excerpt(text, "raw", max_length=20)
    assert len(excerpt) <= 23 # 20 + "..."
    assert "..." in excerpt

def test_sanitize_html_tags():
    html = "<script>alert(1)</script><p>Safe</p>"
    sanitized = sanitize_html(html)
    assert "<script>" not in sanitized
    assert "<p>Safe</p>" in sanitized

def test_sanitize_html_attributes():
    html = '<a href="javascript:alert(1)">Link</a>'
    sanitized = sanitize_html(html)
    # javascript: protocol should be removed or tag stripped if strict
    # The implementation filters attrs. 
    # 'href' allows 'http', 'https', '/', '#', 'mailto'.
    # 'javascript:' doesn't start with these.
    # The implementation appends allowed attrs.
    # So it should be <a>Link</a> or <a >Link</a>.
    assert "javascript" not in sanitized

def test_truncate_text():
    # max_length 5, suffix 3: max_content is 2. "He" + "..." = "He..."
    assert truncate_text("Hello World", 5) == "He..."
    assert truncate_text("Hello", 10) == "Hello"

def test_extract_first_image_priorities():
    content = """
    <img src="html.jpg">
    ![Markdown](md.jpg)
    """
    # Regex search finds first match.
    # extract_first_image checks markdown first, then html.
    assert extract_first_image(content) == "md.jpg" 
    
    content_html = '<img src="html.jpg">'
    assert extract_first_image(content_html) == "html.jpg"

def test_extract_all_media_types():
    content = """
    ![Img](img.jpg)
    <video src="vid.mp4"></video>
    <source src="vid.webm">
    """
    media = extract_all_media(content)
    assert len(media) == 3
    assert media[0]["type"] == "image"
    assert media[1]["type"] == "video"
    assert media[2]["type"] == "video"

def test_truncate_paragraphs():
    html = "<p>P1</p><div>Div</div><p>P2</p><p>P3</p>"
    truncated = truncate_paragraphs(html, 2)
    assert "<p>P1</p>" in truncated
    assert "<p>P2</p>" in truncated
    assert "<p>P3</p>" not in truncated

def test_determine_thumbnail_priorities():
    content = "![Img](content.jpg)"
    thumb, is_vid = determine_thumbnail(content, "thumb.jpg")
    assert thumb == "thumb.jpg"
    assert is_vid is False
    
    # Video thumb: if explicit thumb is video, implementation tries to find image in content
    # If content has image, it returns that image!
    thumb, is_vid = determine_thumbnail(content, "video.mp4")
    assert thumb == "content.jpg"
    assert is_vid is False 
    
    # Fallback to content
    thumb, is_vid = determine_thumbnail(content, None)
    assert thumb == "content.jpg"
    assert is_vid is False
