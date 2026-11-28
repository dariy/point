/**
 * General DOM and string helpers.
 */

import { PRESS_SLOP_PX } from './pointerMode.ts';

/**
 * Escape a string for safe inclusion in an HTML attribute or text node.
 * MUST be called on any user-provided value interpolated into HTML templates.
 */
export function escapeHtml(value: unknown): string {
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
 * @returns markup — the text escaped, with
 *   <a> tags for any URLs found
 */
export function linkify(text: string): RawHtml {
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
 */
export function safeUrl(url: string): string {
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
 * @returns false where matchMedia is absent (SSR / test env), which
 *   keeps the full-height layout as the assumption when we cannot measure.
 */
export function isShortViewport(): boolean {
  return !!window.matchMedia?.(SHORT_VIEWPORT_QUERY).matches;
}

/**
 * Debounce a function — delays execution until `ms` milliseconds have passed
 * since the last call.
 *
 * Generic in the wrapped function so the result stays callable wherever the
 * original was — an event listener, most often, which the bare `Function`
 * type is not assignable to.
 */
export function debounce<F extends (...args: any[]) => any>(
  fn: F,
  ms: number,
): (...args: Parameters<F>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return function (this: unknown, ...args: Parameters<F>) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * Throttle a function — ensures it is called at most once every `ms` ms.
 *
 * Generic in the wrapped function so the result stays callable wherever the
 * original was — an event listener, most often, which the bare `Function`
 * type is not assignable to.
 */
export function throttle<F extends (...args: any[]) => any>(
  fn: F,
  ms: number,
): (...args: Parameters<F>) => void {
  let last = 0;
  return function (this: unknown, ...args: Parameters<F>) {
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
 * @param attrs - Attribute name → value
 * @param text - textContent
 */
export function createElement(
  tag: string,
  attrs: Record<string, string> = {},
  text: string = '',
): HTMLElement {
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
 */
export function clearElement(el: HTMLElement) {
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
 */
export function dropBrokenImages(root: HTMLElement) {
  if (!root) return;
  root.addEventListener(
    'error',
    (e) => {
      const img = (e.target as HTMLElement);
      if (img.tagName === 'IMG') img.remove();
    },
    true,
  );
}

/**
 * Programmatically navigate to a path using the history API.
 * Dispatches a custom 'navigate' event so the router can handle it without
 * coupling to the router module directly.
 */
export function navigate(path: string, { replace = false, state }: { replace?: boolean; state?: unknown } = {}) {
  // `state` goes into the new history entry; the detail has it only when given.
  const detail = state === undefined ? { path, replace } : { path, replace, state };
  window.dispatchEvent(new CustomEvent('app:navigate', { detail }));
}

/**
 * Set or update the <link rel="canonical"> tag in <head>.
 *
 * @param url - Absolute canonical URL
 */
export function setCanonical(url: string) {
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
 * Settings as the store holds them — what normalizeSettings() returns. A value's
 * type follows its key's name: `*per_page` and `*posts_to_show` are numbers,
 * anything containing `enable` or `show` is a boolean, the rest stay strings.
 * The key decides, which a plain index signature cannot say, so the value
 * type is left to the reader; the wire form is api/settings.ts's Settings.
 */
export type StoreSettings = Record<string, any>;

/**
 * Normalize raw string settings from the backend into proper types.
 *
 * The values are strings off the wire, but a caller may also hand over what a
 * form collected, where a checkbox is already a boolean — hence `any`, and
 * hence the `=== true` / `=== 1` arms below.
 */
export function normalizeSettings(raw: Record<string, any>): StoreSettings {
  if (!raw) return {};
  const result: Record<string, any> = { ...raw };
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
/** Share a post using the native share API or fallback to clipboard. */
export async function sharePost(data: { title: string, url: string }) {
  if (navigator.share) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if ((err as Error | null)?.name === 'AbortError') return;
      console.error('Share failed:', err);
    }
  }

  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(data.url);
    const { setToast } = await import('../store.ts');
    setToast({ message: 'Link copied to clipboard', type: 'success' });
  } catch (err) {
    console.error('Clipboard failed:', err);
  }
}

export interface LongPressOptions {
  /** Hold this long, in ms, before the press fires. */
  delay?: number;
  /**
   * Return false to ignore this pointerdown: no press starts. Use it to keep a
   * mouse on its hover path, or to skip a press on a control.
   */
  accept?: (e: PointerEvent) => boolean;
}

/**
 * Fire `callback` when a pointer is held still on `el` for `delay` ms.
 *
 * "Still" means less than PRESS_SLOP_PX of travel: a stylus tip and a finger
 * report small moves during a hold, and those must not cancel it. A move past
 * the slop, pointerup, pointercancel or pointerleave cancels the press. Only
 * the pointer that started the press can move or end it.
 *
 * A press that fired is no tap: the click that ends it is cancelled in the
 * document's capture phase, before any click handler runs, so a link does not
 * navigate. A keyboard click (detail 0) is never cancelled, and the next
 * pointerdown clears the state.
 *
 * For a touch or pen press the system context menu is blocked; a mouse
 * right-click keeps it. The element gets `-webkit-touch-callout: none`, so iOS
 * shows no link or image callout during the hold.
 *
 * @returns cleanup
 */
export function setupLongPress(
  el: HTMLElement,
  callback: (e: PointerEvent) => void,
  { delay = 400, accept }: LongPressOptions = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let press: { pointerId: number; x: number; y: number } | null = null;
  // The device of the last pointerdown on el, for the contextmenu guard.
  let lastType = '';
  const doc = document;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    press = null;
  };

  // The press fired: the click that ends it is no tap. The guard sits on the
  // document, because the callback can re-render el and the click then lands
  // on the element that replaced it. The next pointerdown anywhere disarms it,
  // so a lift that produced no click does not cost the next tap.
  const onClick = (e: MouseEvent) => {
    disarm();
    if (e.detail === 0) return; // keyboard activation
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const disarm = () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('pointerdown', disarm, true);
  };
  const arm = () => {
    disarm();
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('pointerdown', disarm, true);
  };

  const down = (e: PointerEvent) => {
    cancel();
    lastType = e.pointerType || '';
    // A right-click or a pen eraser is not a press.
    if ((e.button ?? 0) !== 0) return;
    if (accept && !accept(e)) return;
    press = { pointerId: e.pointerId, x: e.clientX ?? 0, y: e.clientY ?? 0 };
    timer = setTimeout(() => {
      timer = null;
      press = null;
      arm();
      callback(e);
    }, delay);
  };

  const move = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.pointerId) return;
    const dx = (e.clientX ?? 0) - press.x;
    const dy = (e.clientY ?? 0) - press.y;
    if (Math.hypot(dx, dy) >= PRESS_SLOP_PX) cancel();
  };

  const end = (e: PointerEvent) => {
    if (press && e.pointerId !== press.pointerId) return;
    cancel();
  };

  const onContextMenu = (e: Event) => {
    const type = (e as PointerEvent).pointerType || lastType;
    if (type === 'touch' || type === 'pen') e.preventDefault();
  };

  el.style.setProperty('-webkit-touch-callout', 'none');
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('contextmenu', onContextMenu);

  return () => {
    cancel();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    el.removeEventListener('pointerleave', end);
    disarm();
    el.removeEventListener('contextmenu', onContextMenu);
  };
}

/**
 * Markup that has already been escaped — what html`` returns, and what raw()
 * asserts about a string. Extends String, so it stringifies anywhere a string
 * is expected (innerHTML, .toString() comparisons in tests).
 */
export class RawHtml extends String {}

/**
 * A markup slot: html`` output, or a plain string — which the tag escapes on
 * the way in, so a caller with nothing to put there can pass "". What every
 * "give me some markup" parameter in this frontend accepts.
 */
export type Slot = string | RawHtml;

/** Wrap a string so the html tag leaves it unescaped. */
export function raw(str: string | RawHtml): RawHtml {
  if (str instanceof RawHtml) return str;
  return new RawHtml(str);
}

/**
 * True for a value html`` (or raw()) produced. Lets a caller tell markup that
 * carries its own escaping from a bare string that does not.
 */
export function isRawHtml(value: unknown): boolean {
  return value instanceof RawHtml;
}

function processValue(val: unknown, isUrl: boolean): string {
  if (Array.isArray(val)) {
    return val.map(v => processValue(v, isUrl)).join('');
  }
  if (val instanceof RawHtml) {
    return val.toString();
  }
  if (val === null || val === undefined) {
    return '';
  }
  return isUrl ? safeUrl(val as string) : escapeHtml(val);
}

/**
 * Template literal tag for safely building HTML strings.
 * Escapes interpolations by default. Applies safeUrl() instead of escapeHtml()
 * if the interpolation lands in a URL attribute.
 */
export function html(strings: TemplateStringsArray, ...values: any[]): RawHtml {
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
 */
let policy: TrustedTypePolicy | null;
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
 * @param sink - name of the sink, for the error message
 * @returns a TrustedHTML where the browser supports it, else the
 *   plain string (TrustedHTML stringifies, so callers need not care)
 */
function trusted(markup: RawHtml, sink: string): string {
  // The contract, enforced rather than documented: a plain string here would
  // reach the sink with nothing having escaped it, which is the whole class of
  // bug the html`` tag exists to remove. There is no escape hatch — build the
  // markup with the tag, and use raw() for the pieces that genuinely need it.
  if (!isRawHtml(markup)) {
    throw new TypeError(
      `${sink} was given ${markup === null ? 'null' : typeof markup} rather than ` +
      'html`` output. Build the markup with the html tag from utils/helpers.ts.',
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
 * lint rule in scripts/oxlint-point.mjs keeps it that way — a bare `.innerHTML =`
 * anywhere in frontend/src is an error.
 *
 * @param markup - html`` output
 */
export function setHTML(el: HTMLElement, markup: RawHtml) {
  // eslint-disable-next-line point/restricted-syntax -- the one innerHTML write.
  el.innerHTML = trusted(markup, 'setHTML');
}

/**
 * Insert markup relative to an element — the insertAdjacentHTML half of
 * setHTML(), with the same contract.
 *
 * @param markup - html`` output
 */
export function insertHTML(
  el: HTMLElement,
  position: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend',
  markup: RawHtml,
) {
  // eslint-disable-next-line point/restricted-syntax -- the one insertAdjacentHTML.
  el.insertAdjacentHTML(position, trusted(markup, 'insertHTML'));
}

/**
 * Parse markup into an inert document, through the policy.
 *
 * `DOMParser.parseFromString` is a Trusted Types sink like the two above — and,
 * in Chromium, for **every** mime type, not only `text/html`. A plain string
 * there throws "This document requires 'TrustedHTML' assignment" even when what
 * comes back is an XML document that never touches the page.
 *
 * The parse happens here rather than at the call site so that the TrustedHTML
 * is minted and consumed inside one function — no caller is left holding a
 * value it could route to a real sink.
 *
 * @param mime - 'image/svg+xml', 'application/xml', …
 * @param Parser - the seam a runtime with no global
 *   `DOMParser` supplies its own through — `node --test`, in particular
 */
export function parseMarkup(
  text: string,
  mime: string,
  Parser: typeof DOMParser = globalThis.DOMParser,
): Document {
  const p = trustedTypesPolicy();
  const str = String(text);
  const value = ((p ? p.createHTML(str) : str as unknown) as string);
  // eslint-disable-next-line point/restricted-syntax -- the one parseFromString.
  return new Parser().parseFromString(value, (mime as DOMParserSupportedType));
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
 * @param url - a same-origin absolute path
 */
export function setScriptSrc(el: HTMLScriptElement, url: string) {
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
 * @param value - anything JSON.stringify accepts
 */
export function setScriptJSON(el: HTMLScriptElement, value: unknown) {
  const json = JSON.stringify(value).replace(/</g, '\\u003c');
  const p = trustedTypesPolicy();
  el.textContent = p ? p.createScript(json) : json;
}
