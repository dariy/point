/**
 * Display formatting helpers: dates, file sizes, text truncation.
 */

/**
 * Format a UTC ISO date string as a human-readable local date.
 * Returns an empty string if the value is falsy.
 *
 * @param {string|null|undefined} iso
 * @param {Intl.DateTimeFormatOptions} [opts]
 * @returns {string}
 */
export function formatDate(iso, opts = { year: 'numeric', month: 'long', day: 'numeric' }) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, opts);
}

/**
 * Format a UTC ISO date string as a short date (e.g. "Feb 19, 2026").
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatDateShort(iso) {
  return formatDate(iso, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Format a UTC ISO date string as a datetime-local string for <time> elements.
 * Returns '' if falsy or invalid.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format a UTC ISO date as a machine-readable string for the `datetime` attribute.
 * Returns '' if falsy or invalid.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function isoDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

/**
 * Format a byte count as a human-readable file size string.
 *
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes == null || bytes < 0) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 2 ** (10 * i);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/**
 * Truncate a string to at most `max` characters, appending '…' if cut.
 *
 * @param {string|null|undefined} str
 * @param {number} max
 * @returns {string}
 */
export function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

/**
 * Strip HTML tags from a string, returning plain text.
 * Used to generate excerpts from content_html.
 *
 * @param {string|null|undefined} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Return a plain-text excerpt from an HTML string, truncated to `max` chars.
 *
 * @param {string|null|undefined} html
 * @param {number} [max=200]
 * @returns {string}
 */
export function htmlExcerpt(html, max = 200) {
  return truncate(stripHtml(html), max);
}

/**
 * Format a view count compactly (e.g. 1200 → "1.2K").
 *
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatCount(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
