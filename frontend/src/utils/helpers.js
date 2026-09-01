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
 * @returns {import('./helpers.js').RawHtml} markup — the text escaped, with
 *   <a> tags for any URLs found
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
    // Not `raw` — that name is the opt-out helper this module exports.
    let found = m[0];
    let tail = '';
    const t = trim.exec(found);
    if (t) { tail = found.slice(t.index); found = found.slice(0, t.index); }
    const href = found.startsWith('http') ? found : `https://${found}`;
    out += html`<a href="${href}" target="_blank" rel="noopener noreferrer">${found}</a>${tail}`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(str.slice(last));
  // Assembled from escaped pieces by hand, so raw() states that once, here.
  return raw(out);
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
      const img = /** @type {HTMLElement} */ (e.target);
      if (img.tagName === 'IMG') img.remove();
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
 * The values are strings off the wire, but a caller may also hand over what a
 * form collected, where a checkbox is already a boolean — hence `any`, and
 * hence the `=== true` / `=== 1` arms below.
 *
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
export function normalizeSettings(raw) {
  if (!raw) return {};
  /** @type {Record<string, any>} */
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
 * @param {function(Event): void} callback
 * @param {number} [duration=400]
 * @returns {function(): void} cleanup
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
 * @param {string|RawHtml} str
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

/**
 * The Trusted Types policy every HTML write in this codebase goes through.
 *
 * Resolved once, lazily, on the first write rather than at module load: the
 * Node tests import this module with no `window` at all, and the demo bundle
 * runs it in pages that may never write HTML. `null` is the normal answer in
 * Firefox and Safari, which do not implement Trusted Types, and in any browser
 * on a page whose CSP names no `trusted-types` directive — the write then
 * assigns a plain string, exactly as it did before.
 *
 * `createHTML` is the identity function on purpose. The escaping happened in
 * the html`` tag, and setHTML() refuses anything the tag did not produce; the
 * policy's job here is not to sanitize a second time but to be the one named
 * gate the browser will accept, so that a write from anywhere else — a future
 * `el.innerHTML = someString`, or an injected script reaching for the same
 * sink — has no policy to go through and throws.
 *
 * @type {TrustedTypePolicy|null}
 */
let policy;
let policyResolved = false;

function trustedTypesPolicy() {
  if (policyResolved) return policy;
  policyResolved = true;
  policy = null;
  const tt = typeof window !== 'undefined' ? window.trustedTypes : undefined;
  if (tt && typeof tt.createPolicy === 'function') {
    try {
      policy = tt.createPolicy('point', {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => {
          // The only scripts this frontend loads by assignment are its own
          // vendored bundles and the comments embed, all at same-origin
          // absolute paths. Anything else — an absolute URL, a protocol
          // relative "//host/x", a data: — is refused here rather than
          // trusted because a caller passed it: the policy is the last place
          // that sees the value before the browser fetches and executes it.
          if (!/^\/[^/]/.test(s)) {
            throw new TypeError(`refusing to load a script from ${s} — same-origin absolute paths only`);
          }
          return s;
        },
      });
    } catch {
      // A duplicate name (a second bundle on the same page) or a CSP whose
      // trusted-types list does not include 'point'. Either way the write
      // still has to happen; under enforcement it will throw at the sink,
      // which is the violation we want reported rather than swallowed here.
      policy = null;
    }
  }
  return policy;
}

/**
 * Convert html`` output into something an HTML sink will accept.
 *
 * @param {import('./helpers.js').RawHtml} markup
 * @param {string} sink  name of the sink, for the error message
 * @returns {string} a TrustedHTML where the browser supports it, else the
 *   plain string (TrustedHTML stringifies, so callers need not care)
 */
function trusted(markup, sink) {
  // The contract, enforced rather than documented: a plain string here would
  // reach the sink with nothing having escaped it, which is the whole class of
  // bug the html`` tag exists to remove. There is no escape hatch — build the
  // markup with the tag, and use raw() for the pieces that genuinely need it.
  if (!isRawHtml(markup)) {
    throw new TypeError(
      `${sink} was given ${markup === null ? 'null' : typeof markup} rather than ` +
      'html`` output. Build the markup with the html tag from utils/helpers.js.',
    );
  }
  const p = trustedTypesPolicy();
  const str = markup.toString();
  return p ? p.createHTML(str) : str;
}

/**
 * Write markup into an element. The single innerHTML in the frontend.
 *
 * Every HTML write goes through here, which is what makes the Trusted Types
 * policy tractable: one gate to register instead of sixty sinks to audit. The
 * lint rule in eslint.config.js keeps it that way — a bare `.innerHTML =`
 * anywhere in frontend/src is an error.
 *
 * @param {HTMLElement} el
 * @param {import('./helpers.js').RawHtml} markup  html`` output
 */
export function setHTML(el, markup) {
  // eslint-disable-next-line no-restricted-syntax -- the one innerHTML write.
  el.innerHTML = trusted(markup, 'setHTML');
}

/**
 * Insert markup relative to an element — the insertAdjacentHTML half of
 * setHTML(), with the same contract.
 *
 * @param {HTMLElement} el
 * @param {'beforebegin'|'afterbegin'|'beforeend'|'afterend'} position
 * @param {import('./helpers.js').RawHtml} markup  html`` output
 */
export function insertHTML(el, position, markup) {
  // eslint-disable-next-line no-restricted-syntax -- the one insertAdjacentHTML.
  el.insertAdjacentHTML(position, trusted(markup, 'insertHTML'));
}

/**
 * Point a <script> at a URL, through the policy.
 *
 * `script.src` is a Trusted Types sink in its own right — under
 * `require-trusted-types-for 'script'` a plain string there is refused just as
 * it is at .innerHTML, and for a better reason: the value decides what code
 * the page runs. The policy's createScriptURL is where the same-origin rule
 * lives, so every dynamic script load is checked in one place.
 *
 * @param {HTMLScriptElement} el
 * @param {string} url  a same-origin absolute path
 */
export function setScriptSrc(el, url) {
  const p = trustedTypesPolicy();
  el.src = p ? p.createScriptURL(String(url)) : String(url);
}

/**
 * Fill a <script> element with JSON — the only script body this frontend
 * writes, and the reason the signature takes a value rather than a string.
 *
 * `script.textContent` is a Trusted Types sink whatever the script's type, so
 * even `application/ld+json` (data the browser never executes) has to go
 * through the policy. Serialising here rather than taking a caller's string
 * keeps that honest: what reaches the sink is provably JSON.stringify output,
 * not markup someone assembled.
 *
 * `<` is escaped on the way out. Assigning to textContent cannot break out of
 * the element on its own, but a document that is later serialised and
 * re-parsed would give a `</script>` inside a title back to the HTML parser.
 *
 * @param {HTMLScriptElement} el
 * @param {unknown} value  anything JSON.stringify accepts
 */
export function setScriptJSON(el, value) {
  const json = JSON.stringify(value).replace(/</g, '\\u003c');
  const p = trustedTypesPolicy();
  el.textContent = p ? p.createScript(json) : json;
}
