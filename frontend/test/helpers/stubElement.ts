/**
 * Hand-rolled element stubs for the pager tests (gridPager, mediaPager).
 *
 * The pagers touch only inline styles, classList, listeners and a few layout
 * reads, so a plain object is enough. The stub also records what a test
 * asserts on: the listeners, the children and whether it was removed.
 */

import { mock } from './mock.ts';

/** A handler registered on a stub. */
export type Listener = (event: object) => void;

/** An inline style: a property bag plus the CSSStyleDeclaration methods the pagers call. */
export class StubStyle {
  [prop: string]: unknown;
  _p = new Map<string, string>();
  setProperty(k: string, v: string) { this._p.set(k, v); }
  removeProperty(k: string) { this._p.delete(k); return ''; }
  getPropertyValue(k: string) { return this._p.get(k) ?? ''; }
}

export class StubClassList {
  _set = new Set<string>();
  add(...cs: string[]) { cs.forEach((c) => this._set.add(c)); }
  remove(...cs: string[]) { cs.forEach((c) => this._set.delete(c)); }
  has(c: string) { return this._set.has(c); }
  contains(c: string) { return this._set.has(c); }
}

/** The layout box a stub reports. */
export type StubRect = Partial<DOMRect>;

export class StubElement {
  [key: string]: unknown;
  style = new StubStyle();
  dataset: Record<string, string> = {};
  classList = new StubClassList();
  children: StubElement[] = [];
  listeners: Record<string, Listener[]> = {};
  parentElement: StubElement | null = null;
  removed = false;
  className = '';
  innerHTML = '';
  disabled = false;
  offsetWidth = 800;
  offsetHeight = 600;
  offsetTop = 0;
  clientWidth = 800;
  clientHeight = 600;
  getBoundingClientRect: () => StubRect = () => ({});
  querySelector: (sel: string) => StubElement | null = () => null;

  /** `extra` overrides any field, as the spread in the old object literal did. */
  constructor(extra: Partial<StubElement> = {}) {
    Object.assign(this, extra);
  }

  addEventListener(type: string, fn: Listener) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type: string, fn: Listener) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  appendChild(c: StubElement) { this.children.push(c); c.parentElement = this; return c; }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.removed = true;
  }
  setAttribute() {}
}

/**
 * Hand a stub to the code under test. The one boundary cast: the stub holds
 * only what the pagers read, and its recorders are not HTMLElement members.
 */
export function asElement(stub: StubElement): HTMLElement {
  return stub as unknown as HTMLElement;
}

/** Dispatch to the handlers registered on a stub element. */
export function fire(el: StubElement, type: string, event: object) {
  for (const fn of el.listeners[type] || []) fn(event);
}

/** Call a listener registered through a typed addEventListener stub, with a partial event. */
export function callListener(fn: EventListenerOrEventListenerObject, event: object) {
  const e = mock<Event>(event);
  if (typeof fn === 'function') fn(e);
  else fn.handleEvent(e);
}

/** Get back the stub behind an element the code under test hands out. */
export function asStub(el: unknown): StubElement {
  if (!(el instanceof StubElement)) throw new Error(`expected a StubElement, got ${String(el)}`);
  return el;
}
