/**
 * Theme Parser Utility.
 * Fetches theme.json and injects CSS Custom Properties into the document head.
 * Supports light/dark/shared structure.
 */

/**
 * Maps a configuration object to CSS variables.
 * @param {object} obj
 * @returns {string}
 */
function mapToCSS(obj) {
  // Map theme.json keys to existing blog CSS tokens
  const tokenMap = {
    'bg-primary': '--bg-primary',
    'bg-secondary': '--bg-secondary',
    'bg-tertiary': '--bg-tertiary',
    'bg-elevated': '--bg-elevated',
    'surface-card': '--surface-card',
    'surface-input': '--surface-input',
    'surface-hover': '--surface-hover',
    'text-primary': '--text-primary',
    'text-secondary': '--text-secondary',
    'text-tertiary': '--text-tertiary',
    'text-muted': '--text-muted',
    'text-inverted': '--text-inverted',
    'accent': '--color-primary',
    'accent-hover': '--color-primary-hover',
    'border-primary': '--border-primary',
    'border-secondary': '--border-secondary',
    'sidebar-bg': '--pt-colors-sidebar-bg',
    'sidebar-text': '--pt-colors-sidebar-text',
    'sidebar-text-hover': '--pt-colors-sidebar-text-hover',
    'sidebar-active-bg': '--pt-colors-sidebar-active-bg',
    'sidebar-border': '--pt-colors-sidebar-border',
    'footer-link': '--footer-link',
    'font-family': '--font-family',
    'base': '--spacing-md' // standard mapping for base spacing
  };

  let css = '';
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null) {
      css += mapToCSS(value);
    } else {
      const varName = tokenMap[key] || `--${key}`;
      css += `  ${varName}: ${value};\n`;
    }
  }
  return css;
}

/**
 * Fetch and parse theme.json, then inject into <head>.
 * @returns {Promise<string>}
 */
export async function parseTheme() {
  const url = '/assets/images/theme.json';
  let themeData = {};

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Theme fetch failed: ${res.status}`);
    themeData = await res.json();
  } catch (err) {
    console.warn('[Theme] Failed to load theme.json, using defaults.', err);
    return '';
  }

  let finalCSS = '';

  // 1. Shared variables (global)
  if (themeData.shared) {
    finalCSS += `:root {\n${mapToCSS(themeData.shared)}}\n`;
  }

  // 2. Light mode variables (default)
  if (themeData.light) {
    finalCSS += `:root {\n${mapToCSS(themeData.light)}}\n`;
  }

  // 3. Dark mode variables (scoped)
  if (themeData.dark) {
    finalCSS += `[data-theme="dark"] {\n${mapToCSS(themeData.dark)}}\n`;
  }

  // 4. Custom CSS injection
  if (themeData.custom_css) {
    finalCSS += `\n/* Custom Theme CSS */\n${themeData.custom_css}\n`;
  }

  // Fallback for simple flat structures (legacy support)
  if (!themeData.light && !themeData.dark && !themeData.shared) {
    finalCSS = `:root {\n${mapToCSS(themeData)}}`;
  }

  if (typeof document !== 'undefined') {
    let styleEl = document.getElementById('point-theme');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'point-theme';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = finalCSS;
  }

  return finalCSS;
}
