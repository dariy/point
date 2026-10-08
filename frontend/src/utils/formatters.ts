/**
 * Display formatting helpers: dates, file sizes, text truncation.
 */

/**
 * Format a UTC ISO date string as a human-readable local date.
 * Returns an empty string if the value is falsy.
 */
export function formatDate(
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' },
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, opts);
}

/** Format a UTC ISO date string as a short date (e.g. "Feb 19, 2026"). */
export function formatDateShort(iso: string | null | undefined): string {
  return formatDate(iso, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Format a UTC ISO date string as a datetime-local string for <time> elements.
 * Returns '' if falsy or invalid.
 */
export function formatDatetime(iso: string | null | undefined): string {
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
 */
export function isoDatetime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** Pattern used to title a post saved without one, when the setting is unset. */
export const DEFAULT_POST_TITLE_FORMAT = 'YYYY-MM-DD';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad2 = (n: number) => String(n).padStart(2, '0');

// Mirrors titleDateTokens in api/internal/services/post_title.go — the editor
// previews the title the backend will assign, so the two must agree, including
// the English month/day names (the server formats them with Go's layouts, not
// the visitor's locale). Longer tokens first: the scanner takes the first match.
const TITLE_DATE_TOKENS: Array<[string, (d: Date) => string]> = [
  ['YYYY', (d) => String(d.getFullYear())],
  ['YY', (d) => String(d.getFullYear()).slice(-2)],
  ['MMMM', (d) => MONTH_NAMES[d.getMonth()]],
  ['MMM', (d) => MONTH_NAMES[d.getMonth()].slice(0, 3)],
  ['MM', (d) => pad2(d.getMonth() + 1)],
  ['DDDD', (d) => DAY_NAMES[d.getDay()]],
  ['DDD', (d) => DAY_NAMES[d.getDay()].slice(0, 3)],
  ['DD', (d) => pad2(d.getDate())],
  ['HH', (d) => pad2(d.getHours())],
  ['mm', (d) => pad2(d.getMinutes())],
  ['ss', (d) => pad2(d.getSeconds())],
];

/**
 * Render a date through a title-format pattern (YYYY-MM-DD and friends).
 * Anything that is not a token is copied through literally; text in square
 * brackets ("[Session] DD.MM") is literal even where it looks like a token.
 */
export function formatTitleDate(format: string, date: Date = new Date()): string {
  let out = '';
  for (let i = 0; i < format.length;) {
    if (format[i] === '[') {
      const end = format.indexOf(']', i);
      if (end >= 0) {
        out += format.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    const token = TITLE_DATE_TOKENS.find(([t]) => format.startsWith(t, i));
    if (token) {
      out += token[1](date);
      i += token[0].length;
    } else {
      out += format[i];
      i += 1;
    }
  }
  return out.trim();
}

/**
 * The title a post saved with an empty title will get, per the blog's
 * `default_post_title_format` setting.
 */
export function defaultPostTitle(settings?: Record<string, unknown>, date: Date = new Date()): string {
  const format = String(settings?.default_post_title_format || '').trim() || DEFAULT_POST_TITLE_FORMAT;
  return formatTitleDate(format, date) || formatTitleDate(DEFAULT_POST_TITLE_FORMAT, date);
}

/** Format a byte count as a human-readable file size string. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 2 ** (10 * i);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** Truncate a string to at most `max` characters, appending '…' if cut. */
export function truncate(str: string | null | undefined, max: number): string {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

/**
 * Strip HTML tags from a string, returning plain text.
 * Used to generate excerpts from content_html.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  let previous;
  do {
    previous = html;
    html = html.replace(/<[^<>]*>/g, '');
  } while (html !== previous);
  return html.replace(/<|>/g, '');
}

/** Return a plain-text excerpt from an HTML string, truncated to `max` chars. */
export function htmlExcerpt(html: string | null | undefined, max: number = 200): string {
  return truncate(stripHtml(html), max);
}

/** Format a view count compactly (e.g. 1200 → "1.2K"). */
export function formatCount(n: number | null | undefined): string {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
