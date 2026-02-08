# URL Linkification and Line Break Handling

## Summary

Implemented automatic URL linkification for the `/posts/<slug>` route. URLs (http:// and https://) in post content are now automatically converted to clickable anchor tags, and `\r\n` line breaks are properly converted to HTML paragraph and line break tags.

## Changes Made

### 1. Added `linkify_urls()` function
**File:** `app/utils/formatters.py`

- Automatically detects URLs (http:// and https://) in HTML content
- Converts them to clickable `<a>` tags with:
  - `target="_blank"` - Opens links in new tab
  - `rel="noopener noreferrer"` - Security best practice
- Intelligently avoids double-linking:
  - URLs already in anchor tags are not re-linked
  - URLs in `src` attributes (images, videos) are not linked
- Strips trailing whitespace (including `\r\n`) from URLs before linkification
- Removes trailing punctuation from URLs (., !, ?, etc.)

### 2. Updated `format_content()` function
**File:** `app/utils/formatters.py`

- Now applies `linkify_urls()` to all formatted content (markdown, HTML, and raw)
- Maintains existing line break handling:
  - `\r\n` → normalized to `\n`
  - Single `\n` → `<br>` tag (line break within paragraph)
  - Double `\n\n` → `<p>` tags (new paragraph)

## Examples

### URL Linkification
**Input:**
```
Check out https://example.com for more info!
```

**Output:**
```html
<p>Check out <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a> for more info!</p>
```

### Multiple URLs
**Input:**
```
Visit https://github.com and http://stackoverflow.com
```

**Output:**
```html
<p>Visit <a href="https://github.com" target="_blank" rel="noopener noreferrer">https://github.com</a> and <a href="http://stackoverflow.com" target="_blank" rel="noopener noreferrer">http://stackoverflow.com</a></p>
```

### Line Breaks
**Input:**
```
First line\r\nSecond line\r\n\r\nThird paragraph
```

**Output:**
```html
<p>First line<br>
Second line</p>
<p>Third paragraph</p>
```

### Combined
**Input:**
```
Check https://example.com\r\nGreat site!\r\n\r\nAlso visit http://github.com
```

**Output:**
```html
<p>Check <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a><br>
Great site!</p>
<p>Also visit <a href="http://github.com" target="_blank" rel="noopener noreferrer">http://github.com</a></p>
```

## Testing

Created comprehensive test suite in `tests/utils/test_linkify.py`:
- ✅ Basic URL linkification
- ✅ Multiple URLs in text
- ✅ URLs in HTML paragraphs
- ✅ Avoiding double-linking
- ✅ Trailing punctuation removal
- ✅ URLs in image src attributes (not linkified)
- ✅ Integration with markdown formatter
- ✅ Integration with HTML formatter
- ✅ Markdown links + plain URLs
- ✅ Complex HTML structures

**Test Results:** All 10 new tests passing, all existing tests passing (734 total)

## Security

- Uses `target="_blank"` with `rel="noopener noreferrer"` to prevent security vulnerabilities
- Only linkifies http:// and https:// URLs (safe protocols)
- Does not modify URLs already in anchor tags or src attributes
- Properly escapes HTML in URL attributes

## Browser Compatibility

The generated HTML is standard and works in all modern browsers. Links open in new tabs by default for better user experience.
