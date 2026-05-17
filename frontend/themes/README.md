# Themes

This directory contains built-in themes for the Point blog.

## Theme Structure

Each theme is a JSON file with three optional top-level keys:

- `shared`: Variables applied to both light and dark modes.
- `light`: Variables applied specifically when `data-theme="light"` (or default).
- `dark`: Variables applied specifically when `data-theme="dark"`.

Variables are mapped to CSS Custom Properties with the `--pt-` prefix.

### Example JSON

```json
{
  "light": {
    "colors": {
      "bg-primary": "#ffffff",
      "text-primary": "#0f172a"
    }
  },
  "dark": {
    "colors": {
      "bg-primary": "#121212",
      "text-primary": "#f1f5f9"
    }
  },
  "shared": {
    "spacing": {
      "base": "1rem"
    }
  }
}
```

This maps to:
- `--pt-colors-bg-primary`
- `--pt-colors-text-primary`
- `--pt-spacing-base`

## Built-in Themes

- `default.json`: Clean, modern look using standard system fonts.
- `ocean.json`: A refreshing blue and teal palette.
- `minimal.json`: High-contrast, paper-like aesthetic with serif typography.

## How to Apply a Theme

To apply a theme, its content must be served at `/assets/images/theme.json` (or whichever URL `themeParser.js` is configured to fetch). The `parseTheme()` utility in `frontend/src/utils/themeParser.js` will then inject the variables into the document head.
