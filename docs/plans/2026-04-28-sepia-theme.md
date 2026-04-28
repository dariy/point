# Sepia Theme Implementation Plan (Revised v2)

> **For Gemini:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new "Sepia" theme to the Point blog to provide a warm, classic photographic aesthetic.

**Architecture (Stage 1 MVP):** This implementation follows the **Stage 1 Theme System** (completed in `point-y1d.1` through `point-y1d.5`). It uses a single JSON configuration in `frontend/themes/sepia.json`. The backend `ThemeService` scans this directory for `.json` files. The frontend `themeParser.js` fetches the active theme and injects CSS variables. 

*Note: The Stage 2 folder-based design (as described in some speculative design docs) is currently blocked and not yet implemented. This plan adheres to the active, verified Stage 1 architecture.*

**Tech Stack:** JSON, CSS (Custom Properties), Go (Backend), Node.js (Test Runner).

---

### Task 1: Create Sepia Theme Configuration

**Files:**
- Create: `frontend/themes/sepia.json`

**Step 1: Create the theme JSON**

```json
{
  "description": "A warm, classic photographic aesthetic with rich brown tones.",
  "preview_color": "#8c6239",
  "light": {
    "colors": {
      "bg-primary": "#f4ecd8",
      "bg-secondary": "#e8dfc4",
      "bg-tertiary": "#dbd0b0",
      "bg-elevated": "#fdf8ec",
      "surface-card": "#fdf8ec",
      "surface-input": "#fdf8ec",
      "surface-hover": "#e8dfc4",
      "text-primary": "#433422",
      "text-secondary": "#5e4a33",
      "text-tertiary": "#7a624a",
      "text-muted": "#9c866e",
      "text-inverted": "#f4ecd8",
      "accent": "#8c6239",
      "accent-hover": "#6d4c2c",
      "border-primary": "#c9bc9c",
      "border-secondary": "#b0a384"
    }
  },
  "dark": {
    "colors": {
      "bg-primary": "#2b261d",
      "bg-secondary": "#363025",
      "bg-tertiary": "#423a2d",
      "bg-elevated": "#363025",
      "surface-card": "#363025",
      "surface-input": "#363025",
      "surface-hover": "#423a2d",
      "text-primary": "#e3d1b0",
      "text-secondary": "#c9b594",
      "text-tertiary": "#a89475",
      "text-muted": "#7a6a52",
      "text-inverted": "#2b261d",
      "accent": "#bc9462",
      "accent-hover": "#d4aa7a",
      "border-primary": "#5e523d",
      "border-secondary": "#4a4130"
    }
  },
  "shared": {
    "typography": {
      "font-family": "'Georgia', serif"
    },
    "spacing": {
      "base": "1rem"
    }
  }
}
```

**Step 2: Commit**

```bash
git add frontend/themes/sepia.json
git commit -m "feat: add sepia theme configuration"
```

---

### Task 2: Verify Backend Recognition

**Files:**
- Test: `api/internal/services/theme_service_test.go`

**Step 1: Run backend theme tests**

Run: `cd api && go test ./internal/services/... -v`
Expected: PASS

---

### Task 3: Verify Frontend Theme Parser

**Files:**
- Modify: `frontend/test/themeParser.test.js`

**Step 1: Add a test case for Sepia theme**

Modify `frontend/test/themeParser.test.js` using the native `node:test` and `node:assert` modules.

```javascript
test('should handle Sepia theme with shared typography', async () => {
  const originalFetch = global.fetch;
  const sepiaTheme = {
    shared: { typography: { 'font-family': 'Georgia' } },
    light: { colors: { 'bg-primary': '#f4ecd8' } },
    dark: { colors: { 'bg-primary': '#2b261d' } }
  };
  
  global.fetch = async () => ({
    ok: true,
    json: async () => sepiaTheme
  });

  const { parseTheme } = await import('../src/utils/themeParser.js');
  const css = await parseTheme();
  
  assert.match(css, /--font-family: Georgia/);
  assert.match(css, /--bg-primary: #f4ecd8/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /--bg-primary: #2b261d/);
  
  global.fetch = originalFetch;
});
```

**Step 2: Run frontend tests**

Run: `node --test frontend/test/themeParser.test.js`
Expected: PASS

---

### Task 4: UI/Integration Verification

**Step 1: Activate Sepia theme**

1. Ensure the app is running.
2. Navigate to `/light/themes`.
3. Locate the "sepia" theme card.
4. Click "Activate".

**Step 2: Verify visual changes**

1. Verify the background color changes to a warm sepia tone (`#f4ecd8`).
2. Verify the font family is Georgia.
3. Toggle dark mode and verify the background becomes dark sepia (`#2b261d`).
