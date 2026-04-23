/**
 * Theme Parser Utility.
 * Fetches theme.json and injects CSS Custom Properties into the document head.
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
    // Fallback defaults could be defined here
  }

  const variables = mapToCSS(themeData);
  const css = `:root {\n${variables}}`;

  if (typeof document !== 'undefined') {
    let styleEl = document.getElementById('point-theme');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'point-theme';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  return css;
}
