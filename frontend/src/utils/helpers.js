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
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>${escapeHtml(tail)}`;
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
  if (url.startsWith('/') || url.startsWith('https://') || url.startsWith('http://')) {
    return url;
  }
  return '#';
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
    if (key.includes('per_page') || key.includes('quota') || key.includes('interval') || key.includes('posts_to_show')) {
      result[key] = parseInt(value, 10) || 0;
    } else if (key.includes('enable') || key.includes('show') || key.includes('use') || key === 'multi_user_mode') {
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
