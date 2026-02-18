"""Text formatting utilities.

Handles Markdown to HTML conversion, excerpt generation, and HTML sanitization.
"""

import html
import re
from pathlib import Path

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

def preprocess_media_links(content: str) -> str:
    """Convert simplified media paths to standard Markdown or HTML.

    Converts /YYYY/MM/filename.ext on its own line to a proper media tag.

    Args:
        content: Raw content

    Returns:
        Content with simplified links converted
    """
    lines = content.split("\n")
    new_lines = []

    # regex for /YYYY/MM/filename.ext
    pattern = re.compile(
        r"^\s*/(\d{4})/(\d{2})/([^ \n\r]+\.(?:jpg|jpeg|png|gif|webp|svg|mp4|mov|webm|mp3|wav|ogg|m4a))\s*$",
        re.IGNORECASE
    )

    for line in lines:
        match = pattern.match(line)
        if match:
            path = f"/{match.group(1)}/{match.group(2)}/{match.group(3)}"
            filename = match.group(3)
            ext = Path(filename).suffix.lower()
            if ext in (".mp4", ".mov", ".webm"):
                new_lines.append(
                    f'<video src="{path}" controls muted loop playsinline style="max-width: 100%;"></video>'
                )
            elif ext in (".mp3", ".wav", ".ogg", ".m4a"):
                new_lines.append(
                    f'<audio src="{path}" controls style="width: 100%; margin: 10px 0;"></audio>'
                )
            else:
                new_lines.append(f'<img src="{path}" alt="{filename}" style="max-width: 100%;">')
        else:
            new_lines.append(line)

    return "\n".join(new_lines)

def linkify_urls(html_content: str) -> str:
    """Convert plain text URLs to clickable anchor tags.

    Detects URLs in HTML content and wraps them with <a> tags.
    Avoids double-linking URLs that are already in anchor tags or image/video src attributes.

    Args:
        html_content: HTML string

    Returns:
        HTML with URLs converted to links
    """
    # URL pattern - matches http:// and https:// URLs
    url_pattern = re.compile(
        r'(?<!href=")(?<!src=")(?<!href=\')(?<!src=\')'  # Negative lookbehind - not in href or src
        r'(https?://[^\s<>"\']+)',  # The URL itself
        re.IGNORECASE
    )

    def replace_url(match: re.Match[str]) -> str:
        url = match.group(1)
        # Strip all trailing whitespace (including \r\n) and punctuation
        url = url.rstrip()
        # Remove trailing punctuation that's likely not part of the URL
        while url and url[-1] in '.,;:!?)':
            url = url[:-1]
        return f'<a href="{url}" target="_blank" rel="noopener noreferrer">{url}</a>'

    # Split content by tags to avoid modifying content inside tags
    parts = re.split(r'(<[^>]+>)', html_content)

    result = []
    for i, part in enumerate(parts):
        # Only linkify text content (odd indices), not tags (even indices)
        if i % 2 == 0:
            # Check if we're inside an <a> tag
            # Simple heuristic: count opening and closing <a> tags before this part
            preceding = ''.join(parts[:i])
            open_a_tags = len(re.findall(r'<a\s', preceding, re.IGNORECASE))
            close_a_tags = len(re.findall(r'</a>', preceding, re.IGNORECASE))

            # Only linkify if we're not inside an <a> tag
            if open_a_tags == close_a_tags:
                part = url_pattern.sub(replace_url, part)

        result.append(part)

    return ''.join(result)

def format_content(content: str, formatter: str) -> str:
    """Format content based on formatter type.

    Args:
        content: Raw content
        formatter: Formatter type (markdown, html, raw)

    Returns:
        Formatted HTML content
    """
    # Normalize line endings - remove actual CRLF and convert literal \r\n strings to actual newlines
    content = content.replace("\r\n", "\n").replace("\\r\\n", "\n")

    html_output = ""

    if formatter == "markdown":
        # Pre-process simplified media links
        preprocessed = preprocess_media_links(content)
        html_output = markdown_to_html(preprocessed)
    elif formatter == "html":
        # HTML content is passed through (should be sanitized on input)
        html_output = preprocess_media_links(content)
    else:
        # Raw text - escape HTML and preserve whitespace
        escaped = html.escape(content)
        html_output = f"<pre>{escaped}</pre>"

    # Apply URL linkification to all formatted content
    html_output = linkify_urls(html_output)

    return html_output

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
    if not html_content:
        return ""

    # 1. Unescape HTML entities first to catch tags hidden in entities (like &lt;video&gt;)
    # This prevents these from being returned as unescaped tags that then get escaped again by Jinja.
    text = html.unescape(html_content)

    # 2. Remove style and script tags content completely
    text = re.sub(r"<(style|script)[^>]*>.*?</\1>", "", text, flags=re.DOTALL | re.IGNORECASE)

    # 3. Replace <br> and </p> with newlines to preserve spacing
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p>", "\n\n", text, flags=re.IGNORECASE)

    # 4. Strip all other tags
    text = re.sub(r"<[^>]+>", "", text)

    # 5. Normalize whitespace (including \r\n and multiple spaces)
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
        >>> generate_excerpt("# Title\n\nThis is a long paragraph...", max_length=20)
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
        "video",
        "source",
    }

    # Allowed attributes for specific tags
    allowed_attrs = {
        "a": {"href", "title", "target", "rel"},
        "img": {"src", "alt", "title", "width", "height"},
        "video": {"src", "controls", "width", "height", "autoplay", "muted", "loop", "poster", "preload"},
        "source": {"src", "type"},
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
        for attr_match in re.finditer(r'(\w+)=["\']([^"\\]*)["\']', attrs_str):
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
    # Preprocess simplified media links
    content = preprocess_media_links(content)

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
    # Preprocess simplified media links
    content = preprocess_media_links(content)

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

def extract_all_media(content: str) -> list[dict[str, str]]:
    """Extract all image, video, and audio URLs from content.

    Supports Markdown images, HTML tags (img, video, audio, source),
    and simplified media paths (/YYYY/MM/filename.ext).

    Args:
        content: Raw content (markdown or html)

    Returns:
        List of dictionaries with 'url' and 'type' ('image', 'video', or 'audio').
    """
    media = []

    # Common extensions
    video_extensions = {".mp4", ".webm", ".mov", ".m4v", ".ogv"}
    audio_extensions = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".oga"}

    def get_type(url_str: str, default_type: str = "image") -> str:
        url_lower = url_str.lower().split("?")[0]
        ext = Path(url_lower).suffix
        if ext in video_extensions:
            return "video"
        if ext in audio_extensions:
            return "audio"
        return default_type

    # 1. Simplified media paths: /YYYY/MM/filename.ext
    # We look for these before any other processing, ensuring they aren't part of a longer path
    simplified_pattern = re.compile(
        r"(?<![\w/])/(?P<year>\d{4})/(?P<month>\d{2})/(?P<file>[^ \n\r\t\"'<>)]+\.(?P<ext>jpg|jpeg|png|gif|webp|svg|mp4|mov|webm|mp3|wav|ogg|m4a))",
        re.IGNORECASE
    )
    for match in simplified_pattern.finditer(content):
        url = match.group(0)
        media.append({"url": url, "type": get_type(url)})

    # 2. Markdown images: ![alt](url)
    markdown_matches = re.findall(r"!\[.*?\]\((.*?)(?:\s+\".*?\")?\)", content)
    for url in markdown_matches:
        url = url.strip()
        media.append({"url": url, "type": get_type(url)})

    # 3. HTML tags: img, video, audio, source
    # Flexible regex to catch src in various positions
    tag_pattern = re.compile(
        r"<(?:img|video|audio|source)[^>]+src=(?:\"(?P<src1>[^\"]+)\"|'(?P<src2>[^']+)')",
        re.IGNORECASE
    )
    for match in tag_pattern.finditer(content):
        url = match.group("src1") or match.group("src2")
        if url:
            media.append({"url": url.strip(), "type": get_type(url)})

    # Remove duplicates while preserving order
    seen = set()
    unique_media = []
    for item in media:
        if item["url"] not in seen:
            unique_media.append(item)
            seen.add(item["url"])

    return unique_media

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
    paragraphs = re.findall(r"<p>(.*?)</p>", html_content, re.DOTALL | re.IGNORECASE)

    # Filter out paragraphs that only contained images or whitespace
    clean_paragraphs = []
    for p in paragraphs:
        # Remove img tags
        p_clean = re.sub(r"<img[^>]+>", "", p, flags=re.IGNORECASE)
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
        parts = text.split("\n\n")
        selected = [p.strip() for p in parts if p.strip()][:num_paragraphs]
        return "".join(f"<p>{p}</p>" for p in selected)

    return "".join(clean_paragraphs)

def determine_thumbnail(
    content: str,
    thumbnail_path: str | None,
    storage_path: str | None = None,
    use_thumbnails: bool = True
) -> tuple[str | None, str]:
    """Determine the thumbnail path and type for a post content.

    Args:
        content: Post content (markdown or html)
        thumbnail_path: Explicit thumbnail path (or None)
        storage_path: Optional storage path to check for file existence
        use_thumbnails: Whether to prefer thumbnails over originals

    Returns:
        Tuple of (thumbnail_path, type) where type is 'image', 'video', or 'audio'
    """
    media_list = extract_all_media(content)

    video_extensions = (".mp4", ".webm", ".ogg", ".mov", ".m4v")
    audio_extensions = (".mp3", ".wav", ".ogg", ".m4a")

    def get_media_type(url: str) -> str:
        url_lower = url.lower().split("?")[0]
        if any(url_lower.endswith(ext) for ext in video_extensions):
            return "video"
        if any(url_lower.endswith(ext) for ext in audio_extensions):
            return "audio"
        return "image"

    thumb_path = thumbnail_path
    media_type = "image"

    if thumb_path:
        media_type = get_media_type(thumb_path)

    # If use_thumbnails is False, force fallback to original if it's a thumbnail
    if not use_thumbnails and thumb_path and "/media/thumbnails/" in thumb_path:
        thumb_path = thumb_path.replace("/thumbnails/", "/originals/")
        media_type = get_media_type(thumb_path)

    # If we have a thumbnail path, check if it exists if storage_path is provided
    if use_thumbnails and thumb_path and storage_path and "/media/thumbnails/" in thumb_path:
        rel_path = thumb_path.split("/media/", 1)[1]
        full_path = Path(storage_path) / "media" / rel_path
        if not full_path.exists():
            # Fallback to original
            original_path = thumb_path.replace("/thumbnails/", "/originals/")
            rel_original = original_path.split("/media/", 1)[1]
            full_original = Path(storage_path) / "media" / rel_original
            if full_original.exists():
                thumb_path = original_path
                media_type = get_media_type(thumb_path)
            else:
                # If original also missing, set to None so we search content
                thumb_path = None

    # If we have no thumb or it's a video/audio without a real thumbnail, try to find an image in content
    if not thumb_path or media_type in ("video", "audio"):
        first_image = next((m["url"] for m in media_list if m["type"] == "image"), None)
        if first_image:
            thumb_path = first_image
            media_type = "image"
        elif not thumb_path and media_list:
            # Fallback to first video or audio if no image at all
            thumb_path = media_list[0]["url"]
            media_type = media_list[0]["type"]

    return thumb_path, media_type
