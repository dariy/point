"""Text formatting utilities.

Handles Markdown to HTML conversion, excerpt generation, and HTML sanitization.
"""

import html
import re

import markdown


def markdown_to_html(content: str) -> str:
    """Convert Markdown content to HTML.

    Args:
        content: Markdown text

    Returns:
        HTML string

    Examples:
        >>> markdown_to_html("# Hello")
        '<h1>Hello</h1>'
    """
    md = markdown.Markdown(
        extensions=[
            "fenced_code",
            "tables",
            "toc",
            "nl2br",
            "sane_lists",
        ],
        output_format="html",
    )
    return md.convert(content)


def format_content(content: str, formatter: str) -> str:
    """Format content based on formatter type.

    Args:
        content: Raw content
        formatter: Formatter type (markdown, html, raw)

    Returns:
        Formatted HTML content
    """
    if formatter == "markdown":
        return markdown_to_html(content)
    elif formatter == "html":
        # HTML content is passed through (should be sanitized on input)
        return content
    else:
        # Raw text - escape HTML and preserve whitespace
        escaped = html.escape(content)
        return f"<pre>{escaped}</pre>"


def strip_html(html_content: str) -> str:
    """Remove HTML tags from content.

    Args:
        html_content: HTML string

    Returns:
        Plain text without HTML tags

    Examples:
        >>> strip_html("<p>Hello <strong>world</strong></p>")
        'Hello world'
    """
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", html_content)
    # Decode HTML entities
    text = html.unescape(text)
    # Normalize whitespace
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def generate_excerpt(
    content: str,
    formatter: str = "markdown",
    max_length: int = 300,
) -> str:
    """Generate an excerpt from content.

    Converts content to plain text and truncates to max length.

    Args:
        content: Raw content (markdown, html, or raw)
        formatter: Content formatter type
        max_length: Maximum excerpt length

    Returns:
        Plain text excerpt

    Examples:
        >>> generate_excerpt("# Title\\n\\nThis is a long paragraph...", max_length=20)
        'Title This is a...'
    """
    # Convert to HTML first
    html_content = format_content(content, formatter)

    # Strip HTML to get plain text
    text = strip_html(html_content)

    if len(text) <= max_length:
        return text

    # Truncate at word boundary
    truncated = text[:max_length]

    # Find last space to avoid cutting words
    last_space = truncated.rfind(" ")
    if last_space > max_length * 0.7:  # Only use if reasonably close to end
        truncated = truncated[:last_space]

    return truncated.rstrip() + "..."


def sanitize_html(html_content: str) -> str:
    """Sanitize HTML content to prevent XSS.

    Allows safe HTML tags while removing potentially dangerous ones.

    Args:
        html_content: HTML string to sanitize

    Returns:
        Sanitized HTML string
    """
    # List of allowed tags
    allowed_tags = {
        "p",
        "br",
        "strong",
        "b",
        "em",
        "i",
        "u",
        "s",
        "strike",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "a",
        "img",
        "blockquote",
        "pre",
        "code",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "hr",
        "div",
        "span",
        "figure",
        "figcaption",
    }

    # Allowed attributes for specific tags
    allowed_attrs = {
        "a": {"href", "title", "target", "rel"},
        "img": {"src", "alt", "title", "width", "height"},
        "td": {"colspan", "rowspan"},
        "th": {"colspan", "rowspan"},
    }

    def sanitize_tag(match: re.Match[str]) -> str:
        """Sanitize a single HTML tag."""
        tag_content = match.group(1)

        # Check if it's a closing tag
        if tag_content.startswith("/"):
            tag_name = tag_content[1:].split()[0].lower()
            if tag_name in allowed_tags:
                return f"</{tag_name}>"
            return ""

        # Parse opening tag
        parts = tag_content.split(None, 1)
        tag_name = parts[0].lower().rstrip("/")

        if tag_name not in allowed_tags:
            return ""

        # Handle self-closing tags
        is_self_closing = tag_content.rstrip().endswith("/")

        # No attributes
        if len(parts) == 1:
            if is_self_closing:
                return f"<{tag_name} />"
            return f"<{tag_name}>"

        # Parse and filter attributes
        attrs_str = parts[1].rstrip("/").strip()
        tag_allowed_attrs = allowed_attrs.get(tag_name, set())

        # Simple attribute parsing
        safe_attrs = []
        for attr_match in re.finditer(r'(\w+)=["\']([^"\']*)["\']', attrs_str):
            attr_name = attr_match.group(1).lower()
            attr_value = attr_match.group(2)

            if attr_name in tag_allowed_attrs:
                # Extra safety for href and src
                if attr_name in ("href", "src"):
                    # Only allow safe protocols
                    if attr_value.startswith(
                        ("http://", "https://", "/", "#", "mailto:")
                    ):
                        safe_attrs.append(f'{attr_name}="{html.escape(attr_value)}"')
                else:
                    safe_attrs.append(f'{attr_name}="{html.escape(attr_value)}"')

        attrs = " " + " ".join(safe_attrs) if safe_attrs else ""

        if is_self_closing:
            return f"<{tag_name}{attrs} />"
        return f"<{tag_name}{attrs}>"

    # Process all tags
    sanitized = re.sub(r"<([^>]+)>", sanitize_tag, html_content)

    return sanitized


def truncate_text(text: str, max_length: int, suffix: str = "...") -> str:
    """Truncate text to a maximum length at word boundary.

    Args:
        text: Text to truncate
        max_length: Maximum length
        suffix: Suffix to append if truncated

    Returns:
        Truncated text
    """
    if len(text) <= max_length:
        return text

    # Account for suffix length
    max_content = max_length - len(suffix)

    truncated = text[:max_content]
    last_space = truncated.rfind(" ")

    if last_space > max_content * 0.5:
        truncated = truncated[:last_space]

    return truncated.rstrip() + suffix


def extract_first_image(content: str) -> str | None:
    """Extract the first image URL from content.

    Supports Markdown image syntax and HTML img tags.

    Args:
        content: Raw content (markdown or html)

    Returns:
        URL of the first image found, or None if no image exists.
    """
    # Try Markdown image first: ![alt](url "title") or ![alt](url)
    # This regex captures the URL in group 1
    markdown_match = re.search(r'!\[.*?\]\((.*?)(?:\s+".*?")?\)', content)
    if markdown_match:
        return markdown_match.group(1).strip()

    # Try HTML img tag: <img src="url" ...>
    # This regex captures the src value in group 2 or 3 (depending on quotes)
    html_match = re.search(r'<img[^>]+src=(["\'])(.*?)\1', content, re.IGNORECASE)
    if html_match:
        return html_match.group(2).strip()

    return None


def extract_all_images(content: str) -> list[str]:
    """Extract all image URLs from content.

    Supports Markdown image syntax and HTML img tags.

    Args:
        content: Raw content (markdown or html)

    Returns:
        List of image URLs found.
    """
    images = []

    # Try Markdown image first: ![alt](url "title") or ![alt](url)
    # This regex captures the URL in group 1
    markdown_matches = re.findall(r'!\[.*?\]\((.*?)(?:\s+".*?")?\)', content)
    if markdown_matches:
        images.extend([url.strip() for url in markdown_matches])

    # Try HTML img tag: <img src="url" ...>
    # This regex captures the src value in group 2 or 3 (depending on quotes)
    html_matches = re.findall(r'<img[^>]+src=(["\'])(.*?)\1', content, re.IGNORECASE)
    if html_matches:
        images.extend([match[1].strip() for match in html_matches])

    # Remove duplicates while preserving order
    seen = set()
    unique_images = []
    for img in images:
        if img not in seen:
            unique_images.append(img)
            seen.add(img)

    return unique_images


def truncate_paragraphs(html_content: str, num_paragraphs: int = 2) -> str:
    """Extract and truncate text from the first N paragraphs of HTML content.
    
    Args:
        html_content: HTML string
        num_paragraphs: Number of paragraphs to extract
        
    Returns:
        Formatted HTML with only the first N paragraphs (text only, mostly).
    """
    if not html_content:
        return ""

    # Simple regex to find paragraphs. This is not a full HTML parser but efficient enough for this.
    # We look for <p> tags.
    paragraphs = re.findall(r'<p>(.*?)</p>', html_content, re.DOTALL | re.IGNORECASE)
    
    # Filter out paragraphs that only contained images or whitespace
    clean_paragraphs = []
    for p in paragraphs:
        # Remove img tags
        p_clean = re.sub(r'<img[^>]+>', '', p, flags=re.IGNORECASE)
        # Strip other HTML tags for preview? Or keep basic ones?
        # User said "Remove any markdown markup", and we are in HTML now.
        # Let's strip all tags inside paragraphs to be safe and clean.
        p_text = strip_html(p_clean)
        if p_text.strip():
            clean_paragraphs.append(f"<p>{p_text.strip()}</p>")
            if len(clean_paragraphs) >= num_paragraphs:
                break
    
    if not clean_paragraphs:
        # If no p tags or all were empty, fallback to strip html and truncate
        text = strip_html(html_content)
        # Split by double newlines to simulate paragraphs
        parts = text.split('\n\n')
        selected = [p.strip() for p in parts if p.strip()][:num_paragraphs]
        return "".join(f"<p>{p}</p>" for p in selected)

    return "".join(clean_paragraphs)
