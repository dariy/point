/**
 * Theme Parser Utility.
 * Fetches theme.json and injects CSS Custom Properties into the document head.
 * Supports light/dark/shared structure.
 */

/**
 * Maps a configuration object to CSS variables recursively.
 * @param {object} obj
 * @param {string} prefix
 * @returns {string}
 */
function mapToCSS(obj, prefix = '--pt-') {
  let css = '';
  for (const [key, value] of Object.entries(obj)) {
    const name = `${prefix}${key.replace(/_/g, '-')}`;
    if (typeof value === 'object' && value !== null) {
      css += mapToCSS(value, `${name}-`);
    } else {
      css += `  ${name}: ${value};\n`;
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
