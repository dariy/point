/**
 * A real-enough DOM for tests, via linkedom.
 *
 * The frontend's older tests hand-stub `global.document` with no-op objects,
 * which is only good enough to call render() and assert on the returned
 * string. Anything that appends nodes, dispatches events or reads back
 * classList needs a document that actually behaves like one — that is what
 * this provides, without a browser.
 *
 * Usage:
 *   import { setupDOM } from './helpers/dom.js';
 *   const dom = setupDOM();            // installs globals
 *   ...
 *   dom.cleanup();                     // restores whatever was there before
 *
 * Call it in a beforeEach so state (and document.body) never leaks between
 * tests — several of these components append their overlay to document.body.
 */

import { parseHTML } from 'linkedom';

const GLOBAL_KEYS = ['window', 'document', 'Event', 'MouseEvent', 'KeyboardEvent',
  'CustomEvent', 'Node', 'HTMLElement', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'matchMedia', 'location', 'history'];

/**
 * A history/location pair that records pushes instead of navigating.
 * Pages here read `location.pathname` and call `history.pushState` directly
 * as globals, so both have to exist standalone, not only on `window`.
 */
function makeNavigation(path = '/') {
  const location = { pathname: path, search: '', hash: '', href: 'http://localhost' + path };
  const entries = [];
  const history = {
    entries,
    pushState(state, title, url) { entries.push(['push', url]); location.pathname = String(url); },
    replaceState(state, title, url) { entries.push(['replace', url]); location.pathname = String(url); },
    back() { entries.push(['back']); },
  };
  return { location, history };
}

export function setupDOM(html = '<!doctype html><html><body></body></html>', { path = '/' } = {}) {
  const saved = new Map(GLOBAL_KEYS.map(k => [k, globalThis[k]]));
  const win = parseHTML(html);

  globalThis.window = win;
  globalThis.document = win.document;
  for (const k of ['Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'Node', 'HTMLElement']) {
    if (win[k]) globalThis[k] = win[k];
  }

  // linkedom has no layout engine; components that ask for geometry get zeros
  // rather than a crash. Tests that care assert on classes and calls instead.
  globalThis.getComputedStyle = win.getComputedStyle
    ? win.getComputedStyle.bind(win)
    : () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = cb => { cb(0); return 0; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.matchMedia = q => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  win.requestAnimationFrame ??= globalThis.requestAnimationFrame;
  win.matchMedia ??= globalThis.matchMedia;

  const nav = makeNavigation(path);
  globalThis.location = nav.location;
  globalThis.history = nav.history;
  win.location = nav.location;
  win.history = nav.history;

  const unpatch = patchFormReflection(win);

  return {
    window: win,
    document: win.document,
    body: win.document.body,
    location: nav.location,
    history: nav.history,
    cleanup() {
      unpatch();
      for (const [k, v] of saved) {
        if (v === undefined) delete globalThis[k];
        else globalThis[k] = v;
      }
    },
  };
}

/**
 * Teach linkedom the attribute/property reflection a browser does for free.
 *
 * Out of the box, linkedom stores `.checked` / `.selected` as plain expandos
 * that know nothing about the markup: an <input checked> parsed from an HTML
 * string reports `.checked === undefined`, and its selector engine resolves
 * `:checked` against the attribute, which assigning the property never
 * updates. The two failure modes point opposite ways — a test can assert a
 * default that is really true in a browser and see undefined, or set a
 * property and find `querySelector(':checked')` still empty — and both look
 * like product bugs.
 *
 * Defining real accessors that read through to the attribute makes both agree
 * with a browser for every use in this codebase. The one deliberate
 * divergence: assigning the property here also writes the attribute, which a
 * browser does not do. Nothing here reads the raw `checked`/`selected`
 * attribute, so that is unobservable — but it is why this lives in the test
 * harness and not in the source.
 */
function patchFormReflection(win) {
  const undo = [];
  const reflect = (ctorName, prop, attr) => {
    const proto = win[ctorName]?.prototype;
    if (!proto || Object.getOwnPropertyDescriptor(proto, prop)) return;
    const KEY = Symbol(prop);
    Object.defineProperty(proto, prop, {
      configurable: true,
      get() { return this[KEY] ?? this.hasAttribute(attr); },
      set(v) {
        this[KEY] = !!v;
        if (v) this.setAttribute(attr, '');
        else this.removeAttribute(attr);
      },
    });
    undo.push(() => delete proto[prop]);
  };

  reflect('HTMLInputElement', 'checked', 'checked');
  reflect('HTMLOptionElement', 'selected', 'selected');

  return () => undo.forEach(fn => fn());
}

/** Dispatch a bubbling event of `type` on `el`, with optional extra props. */
export function fire(el, type, props = {}) {
  const evt = new globalThis.Event(type, { bubbles: true, cancelable: true });
  Object.assign(evt, props);
  el.dispatchEvent(evt);
  return evt;
}

/** Click helper — the overwhelmingly common case. */
export function click(el, props = {}) {
  return fire(el, 'click', props);
}

/** Set an input's value and fire the `input` event the page listens for. */
export function type(input, value) {
  input.value = value;
  return fire(input, 'input');
}

/**
 * Choose an <option> by value and fire `change`.
 *
 * linkedom derives `select.value` from the option carrying the `selected`
 * ATTRIBUTE, and reports `undefined` when none does — a browser would report
 * the first option's value. Setting the attribute is what makes the two agree.
 */
export function selectOption(select, value) {
  select.querySelectorAll('option').forEach(o => {
    if (o.getAttribute('value') === value) o.setAttribute('selected', '');
    else o.removeAttribute('selected');
  });
  fire(select, 'change');
  return select;
}

/**
 * Tick a checkbox/radio the way a user would.
 *
 * Necessary because linkedom's selector engine resolves `:checked` against the
 * ATTRIBUTE, while a browser resolves it against the PROPERTY. Setting only
 * `el.checked = true` leaves `querySelector('input:checked')` returning null
 * here but not in a browser — a difference that would let a test pass while
 * the real confirm button does nothing. Set both, and for radios clear the
 * rest of the group so the attribute state stays as exclusive as the property.
 */
export function check(el, on = true) {
  const root = el.getRootNode?.() ?? document;
  if (on && el.type === 'radio' && el.name) {
    root.querySelectorAll(`input[type="radio"][name="${el.name}"]`).forEach(other => {
      if (other !== el) { other.checked = false; other.removeAttribute('checked'); }
    });
  }
  el.checked = on;
  if (on) el.setAttribute('checked', '');
  else el.removeAttribute('checked');
  fire(el, 'change');
  return el;
}
