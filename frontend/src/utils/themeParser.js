/**
 * Theme loader. Fetches theme.css and injects it into the document head.
 */

export async function parseTheme({ bust = false } = {}) {
  const url = bust
    ? `/assets/css/theme.css?t=${Date.now()}`
    : '/assets/css/theme.css';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Theme fetch failed: ${res.status}`);
    const css = await res.text();

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
  } catch (err) {
    console.warn('[Theme] Failed to load theme.css, using defaults.', err);
    return '';
  }
}
