"""Tests for URL linkification in formatters."""

from app.utils.formatters import format_content, linkify_urls


def test_linkify_urls_basic():
    """Test basic URL linkification."""
    text = "Check out https://example.com for more info"
    result = linkify_urls(text)
    assert '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>' in result


def test_linkify_urls_multiple():
    """Test multiple URLs in text."""
    text = "Visit https://example.com and http://test.org"
    result = linkify_urls(text)
    assert '<a href="https://example.com"' in result
    assert '<a href="http://test.org"' in result


def test_linkify_urls_in_paragraph():
    """Test URL linkification inside HTML paragraph."""
    html = "<p>Check this out: https://example.com</p>"
    result = linkify_urls(html)
    assert '<a href="https://example.com"' in result
    assert 'target="_blank"' in result
    assert 'rel="noopener noreferrer"' in result


def test_linkify_urls_avoids_double_linking():
    """Test that URLs already in anchor tags are not double-linked."""
    html = '<a href="https://example.com">Visit https://example.com</a>'
    result = linkify_urls(html)
    # Should only have one anchor tag
    assert result.count('<a href="https://example.com">') == 1
    # Should not have nested anchor tags
    assert '<a href="https://example.com">Visit <a href=' not in result


def test_linkify_urls_removes_trailing_punctuation():
    """Test that trailing punctuation is not included in URLs."""
    text = "Check https://example.com. And https://test.org!"
    result = linkify_urls(text)
    assert 'href="https://example.com"' in result
    assert 'href="https://test.org"' in result
    assert 'href="https://example.com."' not in result
    assert 'href="https://test.org!"' not in result


def test_linkify_urls_in_image_src():
    """Test that URLs in image src attributes are not linkified."""
    html = '<img src="https://example.com/image.jpg" alt="Test">'
    result = linkify_urls(html)
    # Should not create anchor tags for URLs in src attributes
    assert result == html


def test_format_content_linkifies_markdown():
    """Test that format_content linkifies URLs in markdown."""
    content = "Visit https://example.com for more info"
    result = format_content(content, "markdown")
    assert '<a href="https://example.com" target="_blank" rel="noopener noreferrer">' in result


def test_format_content_linkifies_html():
    """Test that format_content linkifies URLs in HTML."""
    content = "<p>Check out https://example.com and http://test.org</p>"
    result = format_content(content, "html")
    assert '<a href="https://example.com"' in result
    assert '<a href="http://test.org"' in result


def test_linkify_urls_with_markdown_links():
    """Test that markdown-style links are not double-linkified."""
    # After markdown processing, this becomes an anchor tag
    content = "Check out [Example](https://example.com) and also https://test.org"
    result = format_content(content, "markdown")
    # Should have the markdown link converted to anchor
    assert 'href="https://example.com"' in result
    # Should also linkify the plain URL
    assert '<a href="https://test.org"' in result


def test_linkify_urls_complex_html():
    """Test linkification in complex HTML structure."""
    html = """
    <div>
        <p>Visit https://example.com for info.</p>
        <p>Also check <a href="https://test.org">this link</a> and https://another.com</p>
    </div>
    """
    result = linkify_urls(html)
    # Should linkify the plain URLs
    assert '<a href="https://example.com"' in result
    assert '<a href="https://another.com"' in result
    # Should preserve existing link
    assert '<a href="https://test.org">this link</a>' in result


def test_linkify_urls_strips_trailing_whitespace():
    """Test that URLs with trailing whitespace (including \\r\\n) are properly cleaned."""
    # Test with \r\n
    text1 = "Check https://en.wikipedia.org/wiki/Test\r\n for info"
    result1 = linkify_urls(text1)
    assert 'href="https://en.wikipedia.org/wiki/Test"' in result1
    assert 'href="https://en.wikipedia.org/wiki/Test\r\n"' not in result1

    # Test with \n
    text2 = "Check https://example.com\n for info"
    result2 = linkify_urls(text2)
    assert 'href="https://example.com"' in result2
    assert 'href="https://example.com\n"' not in result2

    # Test with spaces
    text3 = "Check https://test.org   for info"
    result3 = linkify_urls(text3)
    assert 'href="https://test.org"' in result3
