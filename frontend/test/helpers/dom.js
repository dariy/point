// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
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
  'cancelAnimationFrame', 'matchMedia', 'location', 'history', 'FormData', 'navigator',
  'ResizeObserver', 'localStorage', 'sessionStorage'];

/**
 * Install a global by descriptor.
 *
 * Plain assignment is not enough: Node defines `navigator` as an accessor with
 * no setter, so `globalThis.navigator = …` throws in a module (strict mode).
 */
function def(key, value) {
  Object.defineProperty(globalThis, key, {
    value, writable: true, configurable: true, enumerable: true,
  });
}

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

export function setupDOM(html = '<!doctype html><html><body></body></html>', { path = '/', onLine = true } = {}) {
  const saved = new Map(GLOBAL_KEYS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const win = parseHTML(html);

  def('window', win);
  def('document', win.document);
  win.document.elementFromPoint = () => null;
  for (const k of ['Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'Node', 'HTMLElement']) {
    if (win[k]) def(k, win[k]);
  }

  // api/client.js routes every mutating call through the offline mutation
  // queue (IndexedDB) when `navigator.onLine` is falsy. Node's `navigator`
  // exists but has no `onLine`, so without this the harness would silently
  // send nothing over fetch and hang on a database no test provides.
  def('navigator', { onLine, userAgent: 'point-tests' });
  def('FormData', HarnessFormData);

  // linkedom has no layout engine; components that ask for geometry get zeros
  // rather than a crash. Tests that care assert on classes and calls instead.
  def('getComputedStyle', win.getComputedStyle
    ? win.getComputedStyle.bind(win)
    : () => ({ getPropertyValue: () => '' }));
  def('requestAnimationFrame', cb => { cb(0); return 0; });
  def('cancelAnimationFrame', () => {});
  def('matchMedia', q => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));

  // Missing entirely in linkedom, and a missing constructor is a ReferenceError,
  // not a no-op: the admin header's compact check (utils/headerCompact.js) runs
  // from setupAdminLayout, so without this NO /light page can be mounted at all.
  // Nothing resizes in a test, so the callback would never fire on its own —
  // `observers` exposes the live ones so a test can run one deliberately, and
  // the disconnected flag makes teardown assertable.
  def('ResizeObserver', HarnessResizeObserver);
  HarnessResizeObserver.observers = [];

  // Also absent from linkedom, and also a ReferenceError rather than a no-op —
  // the sidebar reads its collapsed state from localStorage in its constructor.
  // Per-setupDOM instances, so preferences never leak between tests.
  def('localStorage', makeStorage());
  def('sessionStorage', makeStorage());
  win.localStorage = globalThis.localStorage;
  win.sessionStorage = globalThis.sessionStorage;
  win.requestAnimationFrame ??= globalThis.requestAnimationFrame;
  win.matchMedia ??= globalThis.matchMedia;

  const nav = makeNavigation(path);
  def('location', nav.location);
  def('history', nav.history);
  win.location = nav.location;
  win.history = nav.history;

  const unpatch = combine(patchFormReflection(win), patchAbortSignal(win), patchTextSelection(win),
    patchSelectValue(win), patchLayoutGeometry(win));

  return {
    window: win,
    document: win.document,
    body: win.document.body,
    location: nav.location,
    history: nav.history,
    cleanup() {
      unpatch();
      for (const [k, descriptor] of saved) {
        if (descriptor === undefined) delete globalThis[k];
        else Object.defineProperty(globalThis, k, descriptor);
      }
    },
  };
}

/** An in-memory Storage — the Web Storage API, minus persistence. */
function makeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: k => { map.delete(String(k)); },
    clear: () => map.clear(),
  };
}

/**
 * A ResizeObserver that records instead of observing.
 *
 * linkedom has no layout, so there is nothing for a real one to watch; what the
 * code under test needs is only that the constructor exists and that
 * `disconnect()` is there for the teardown to call. Tests that care about the
 * resize path call `trigger()` themselves.
 */
class HarnessResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    this.disconnected = false;
    HarnessResizeObserver.observers.push(this);
  }
  observe(el) { this.targets.push(el); }
  unobserve(el) { this.targets = this.targets.filter(t => t !== el); }
  disconnect() { this.targets = []; this.disconnected = true; }
  /** Run the callback as a resize would, with one entry per observed target. */
  trigger() { this.callback(this.targets.map(target => ({ target })), this); }
}

/**
 * Make `new FormData(form)` read the form, the way a browser does.
 *
 * Node ships a spec FormData, but its constructor takes no arguments — handed
 * an element it throws `Argument 1 could not be converted`. linkedom supplies
 * no FormData of its own. So the single line every save handler starts with,
 * `const fd = new FormData(form)`, is unreachable from a test until something
 * closes the gap; this is that something.
 *
 * It walks the controls and applies the parts of the form-submission algorithm
 * that decide what gets sent, because those decisions ARE the behaviour under
 * test — an unchecked box must be absent (`fd.has('hidden')` is how the page
 * reads booleans), and a disabled control must not be submitted at all.
 *
 * Two linkedom divergences are corrected while reading, both of which would
 * otherwise quietly produce the wrong payload rather than fail:
 *   - `input.type` is null when the markup omits the attribute; a browser says
 *     'text'. Left alone, a bare <input name=…> matches none of the type rules.
 *   - a checkbox with no value attribute reports '' where a browser reports
 *     'on', which is the value the backend would actually receive.
 */
const HarnessFormData = (() => {
  // Captured once, at import: a nested setupDOM must not subclass the shim.
  const Native = globalThis.FormData;

  const controlType = el => (
    el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase()
      : el.tagName.toLowerCase()
  );

  function harvest(form, fd) {
    for (const el of form.querySelectorAll('input, select, textarea')) {
      const name = el.getAttribute('name');
      if (!name || el.disabled) continue;

      const type = controlType(el);
      // Submit-ish controls only submit as the submitter, which nothing here is.
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;

      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) fd.append(name, el.getAttribute('value') ?? 'on');
      } else if (type === 'select') {
        const options = [...el.querySelectorAll('option')];
        // A single select with nothing marked submits its first option in a
        // browser; linkedom reports no selection at all (see selectOption).
        const chosen = options.filter(o => o.selected);
        if (!chosen.length && !el.hasAttribute('multiple') && options.length) chosen.push(options[0]);
        for (const opt of chosen) fd.append(name, opt.getAttribute('value') ?? opt.textContent);
      } else {
        fd.append(name, el.value ?? '');
      }
    }
  }

  return class FormData extends Native {
    constructor(form) {
      super();
      if (form && typeof form.querySelectorAll === 'function') harvest(form, this);
      else if (form !== undefined) throw new TypeError('FormData: not a form element');
    }
  };
})();

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
const combine = (...undos) => () => undos.forEach(fn => fn());

/**
 * Make `addEventListener(..., { signal })` actually detach on abort.
 *
 * linkedom accepts the option and ignores it, so an aborted controller leaves
 * every listener live. Components here use AbortController as their only
 * teardown mechanism (see bindSwipeToReveal), and re-binding after each render
 * depends on it — without this, a test cannot tell a correct teardown from a
 * listener leak, which is the exact bug the teardown exists to prevent.
 */
function patchAbortSignal(win) {
  // The listener methods live on linkedom's DOMEventTarget, several links up
  // the prototype chain from any element.
  let proto = win.document && Object.getPrototypeOf(win.document);
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'addEventListener')) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) return () => {};

  const original = proto.addEventListener;
  proto.addEventListener = function (type, callback, options) {
    const signal = options && typeof options === 'object' ? options.signal : undefined;
    if (signal?.aborted) return;
    original.call(this, type, callback, options);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => this.removeEventListener(type, callback, options),
        { once: true },
      );
    }
  };
  return () => { proto.addEventListener = original; };
}

/**
 * Give text controls a `setSelectionRange`, which linkedom omits entirely.
 *
 * Pages call it to park the caret after re-rendering a field the user is
 * typing in (the tags list search box). Missing, it is not a silent no-op but a
 * TypeError thrown from the middle of afterRender — every listener bound after
 * that point is simply never bound, and the test that follows exercises a page
 * half-wired in a way no browser would produce.
 *
 * The caret is recorded rather than ignored so an assertion about it means
 * something; nothing here reads it back yet.
 */
function patchTextSelection(win) {
  const undo = [];
  for (const ctorName of ['HTMLInputElement', 'HTMLTextAreaElement']) {
    const proto = win[ctorName]?.prototype;
    if (!proto || proto.setSelectionRange) continue;
    proto.setSelectionRange = function (start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    };
    undo.push(() => { delete proto.setSelectionRange; });
  }
  return () => undo.forEach(fn => fn());
}

/**
 * Report zero for the layout metrics linkedom does not implement.
 *
 * The comment above about geometry reading as zeros was aspirational: linkedom
 * defines none of these properties, so they read `undefined`, and `undefined`
 * poisons arithmetic into NaN rather than producing a harmless zero. That is
 * the difference between a self-correcting sizing pass deciding it has nothing
 * to do and one that recomputes a NaN page size, reloads, and recomputes it
 * again — an infinite loop inside a single test.
 *
 * They stay writable so a test that wants to simulate a real viewport can
 * assign one and have the code under test read it back.
 */
function patchLayoutGeometry(win) {
  const proto = win.HTMLElement?.prototype;
  if (!proto) return () => {};
  const METRICS = ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight',
    'clientTop', 'clientLeft', 'clientWidth', 'clientHeight',
    'scrollWidth', 'scrollHeight'];
  const undo = [];
  for (const name of METRICS) {
    if (Object.getOwnPropertyDescriptor(proto, name)) continue;
    const KEY = Symbol(name);
    Object.defineProperty(proto, name, {
      configurable: true,
      get() { return this[KEY] ?? 0; },
      set(v) { this[KEY] = v; },
    });
    undo.push(() => { delete proto[name]; });
  }
  return () => undo.forEach(fn => fn());
}

/**
 * Give <select> the `value` a browser gives it — readable AND writable.
 *
 * linkedom derives `select.value` from whichever option carries the `selected`
 * attribute and offers no setter at all, so the two things pages do with a
 * select both diverge: reading one nothing has touched yields `undefined` where
 * a browser yields the first option's value, and `select.value = 'scheduled'`
 * — the line behind every "set the status for me" action — throws
 * `Cannot set property value` from strict-mode module code rather than
 * selecting anything.
 *
 * The setter moves the `selected` attribute, which is what linkedom's `:checked`
 * / `option.selected` and the FormData shim above already agree on, so a form
 * read back after an assignment reports what a browser would submit.
 */
function patchSelectValue(win) {
  const proto = win.HTMLSelectElement?.prototype;
  const original = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (!original) return () => {};
  Object.defineProperty(proto, 'value', {
    configurable: true,
    get() {
      const current = original.get.call(this);
      if (current !== undefined && current !== null) return current;
      const first = this.querySelector('option');
      return first ? (first.getAttribute('value') ?? first.textContent) : '';
    },
    set(v) {
      for (const option of this.querySelectorAll('option')) {
        const optionValue = option.getAttribute('value') ?? option.textContent;
        if (optionValue === String(v)) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      }
    },
  });
  return () => { Object.defineProperty(proto, 'value', original); };
}

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

  // `indeterminate` is not attribute-backed — there is no such content
  // attribute in HTML, only the property — so it needs a default rather than
  // reflection. linkedom leaves it undefined until something assigns it, while
  // a browser reports false from the start. Without this, asserting that a box
  // is NOT partial reads `undefined`, and `assert.equal(x, false)` fails on a
  // checkbox that a browser would agree is exactly what the test expected.
  const inputProto = win.HTMLInputElement?.prototype;
  if (inputProto && !Object.getOwnPropertyDescriptor(inputProto, 'indeterminate')) {
    const KEY = Symbol('indeterminate');
    Object.defineProperty(inputProto, 'indeterminate', {
      configurable: true,
      get() { return this[KEY] ?? false; },
      set(v) { this[KEY] = !!v; },
    });
    undo.push(() => delete inputProto.indeterminate);
  }

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
