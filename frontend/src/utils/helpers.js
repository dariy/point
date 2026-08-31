/**
 * General DOM and string helpers.
 */

/**
 * Escape a string for safe inclusion in an HTML attribute or text node.
 * MUST be called on any user-provided value interpolated into HTML templates.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape text for HTML and turn bare URLs into clickable anchors (new tab).
 * Used for plain-text fields such as a post excerpt that may carry links —
 * e.g. Instagram URLs — which should render as links rather than raw text.
 *
 * @param {string} text
 * @returns {string} HTML-safe string with <a> tags for any URLs found
 */
export function linkify(text) {
  const str = String(text ?? '');
  const urlRe = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
  // Trailing punctuation shouldn't be swallowed into the link.
  const trim = /[.,;:!?)\]'"]+$/;
  let out = '';
  let last = 0;
  let m;
  while ((m = urlRe.exec(str)) !== null) {
    out += escapeHtml(str.slice(last, m.index));
    let raw = m[0];
    let tail = '';
    const t = trim.exec(raw);
    if (t) { tail = raw.slice(t.index); raw = raw.slice(0, t.index); }
    const href = raw.startsWith('http') ? raw : `https://${raw}`;
    out += html`<a href="${href}" target="_blank" rel="noopener noreferrer">${raw}</a>${tail}`.toString();
    last = m.index + m[0].length;
  }
  out += escapeHtml(str.slice(last));
  return out;
}

/**
 * Return a safe URL string. Only allows relative paths and https:// URLs.
 * Returns '#' for anything else, preventing javascript: protocol injection.
 *
 * @param {string} url
 * @returns {string}
 */
export function safeUrl(url) {
  if (!url) return '#';
  // Strip control characters and leading/trailing whitespace
  // eslint-disable-next-line no-control-regex
  const str = String(url).replace(/^[\s\u0000-\u001F\u007F-\u009F]+|[\s\u0000-\u001F\u007F-\u009F]+$/g, '');
  if (
    (str.startsWith('/') && !str.startsWith('//')) ||
    str.startsWith('https://') ||
    str.startsWith('http://')
  ) {
    return escapeHtml(str);
  }
  return '#';
}

/**
 * Viewports too short to spend height on optional chrome — a phone in
 * landscape, or a desktop window squashed to the same shape.
 *
 * Declared here rather than inline so the CSS that acts on it and the JS that
 * has to know it happened cannot drift: the string is the literal twin of the
 * media query in css/public/timeline.css.
 */
export const SHORT_VIEWPORT_QUERY = '(max-height: 30em)';

/**
 * True when the viewport matches SHORT_VIEWPORT_QUERY.
 *
 * @returns {boolean} false where matchMedia is absent (SSR / test env), which
 *   keeps the full-height layout as the assumption when we cannot measure.
 */
export function isShortViewport() {
  return !!window.matchMedia?.(SHORT_VIEWPORT_QUERY).matches;
}

/**
 * Debounce a function — delays execution until `ms` milliseconds have passed
 * since the last call.
 *
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Throttle a function — ensures it is called at most once every `ms` ms.
 *
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function throttle(fn, ms) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      return fn.apply(this, args);
    }
  };
}

/**
 * Create and append a DOM element with optional attributes and text content.
 *
 * @param {string} tag
 * @param {object} [attrs]  Key-value attribute pairs
 * @param {string} [text]   textContent
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs = {}, text = '') {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  if (text) el.textContent = text;
  return el;
}

/**
 * Remove all children from a DOM node without removing the node itself.
 * Uses textContent for maximum safety (no innerHTML needed).
 *
 * @param {HTMLElement} el
 */
export function clearElement(el) {
  el.textContent = '';
}

/**
 * Drop any <img> under `root` that fails to load, revealing whatever markup
 * sits behind it.
 *
 * Used where a thumbnail URL is optimistic: a video's ?thumb resolves to its
 * captured poster frame, and the server 404s it when the video never got one
 * (uploaded before poster capture, or ingested outside the admin UI). Rather
 * than ask every caller to know which videos have posters, the image is
 * rendered over a placeholder and removed if it does not arrive.
 *
 * `error` does not bubble, hence the capture-phase listener.
 *
 * @param {HTMLElement} root
 */
export function dropBrokenImages(root) {
  if (!root) return;
  root.addEventListener(
    'error',
    (e) => {
      if (e.target.tagName === 'IMG') e.target.remove();
    },
    true,
  );
}

/**
 * Programmatically navigate to a path using the history API.
 * Dispatches a custom 'navigate' event so the router can handle it without
 * coupling to the router module directly.
 *
 * @param {string} path
 * @param {{ replace?: boolean }} [opts]
 */
export function navigate(path, { replace = false } = {}) {
  window.dispatchEvent(
    new CustomEvent('app:navigate', { detail: { path, replace } })
  );
}

/**
 * Set or update the <link rel="canonical"> tag in <head>.
 *
 * @param {string} url  Absolute canonical URL
 */
export function setCanonical(url) {
  let el = document.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', url);
}

/**
 * Remove the <link rel="canonical"> tag if present.
 */
export function removeCanonical() {
  document.querySelector('link[rel="canonical"]')?.remove();
}

/**
 * Normalize raw string settings from the backend into proper types.
 *
 * @param {Record<string, string>} raw
 * @returns {Record<string, any>}
 */
export function normalizeSettings(raw) {
  if (!raw) return {};
  const result = { ...raw };
  for (const key in raw) {
    const value = raw[key];
    if (key.includes('per_page') || key.includes('posts_to_show')) {
      result[key] = parseInt(value, 10) || 0;
    } else if (key.includes('enable') || key.includes('show')) {
      result[key] = value === 'true' || value === '1' || value === true || value === 1;
    }
  }
  return result;
}
/**
 * Share a post using the native share API or fallback to clipboard.
 *
 * @param {{ title: string, url: string }} data
 */
export async function sharePost(data) {
  if (navigator.share) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Share failed:', err);
    }
  }

  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(data.url);
    const { store } = await import('../store.js');
    store.set('toast', { message: 'Link copied to clipboard', type: 'success' });
  } catch (err) {
    console.error('Clipboard failed:', err);
  }
}

/**
 * Setup a long-press listener on an element.
 *
 * @param {HTMLElement} el
 * @param {function(Event)} callback
 * @param {number} [duration=400]
 * @returns {function()} cleanup
 */
export function setupLongPress(el, callback, duration = 400) {
  let timer = null;

  const start = (e) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      callback(e);
    }, duration);
  };

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel, { passive: true });
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('contextmenu', (e) => {
    if (e.pointerType === 'touch') e.preventDefault();
  });

  return () => {
    cancel();
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchend', cancel);
    el.removeEventListener('touchmove', cancel);
  };
}

/**
 * Markup that has already been escaped — what html`` returns, and what raw()
 * asserts about a string. Extends String, so it stringifies anywhere a string
 * is expected (innerHTML, .toString() comparisons in tests).
 */
export class RawHtml extends String {}

/**
 * Wrap a string so the html tag leaves it unescaped.
 *
 * @param {string} str
 * @returns {RawHtml}
 */
export function raw(str) {
  if (str instanceof RawHtml) return str;
  return new RawHtml(str);
}

/**
 * True for a value html`` (or raw()) produced. Lets a caller tell markup that
 * carries its own escaping from a bare string that does not.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRawHtml(value) {
  return value instanceof RawHtml;
}

function processValue(val, isUrl) {
  if (Array.isArray(val)) {
    return val.map(v => processValue(v, isUrl)).join('');
  }
  if (val instanceof RawHtml) {
    return val.toString();
  }
  if (val === null || val === undefined) {
    return '';
  }
  return isUrl ? safeUrl(val) : escapeHtml(val);
}

/**
 * Template literal tag for safely building HTML strings.
 * Escapes interpolations by default. Applies safeUrl() instead of escapeHtml()
 * if the interpolation lands in a URL attribute.
 *
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {RawHtml}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const prev = strings[i];
    const isUrl = /(?:href|src|formaction|xlink:href)="$/i.test(prev);
    out += processValue(values[i], isUrl);
    out += strings[i + 1];
  }
  return new RawHtml(out);
}
