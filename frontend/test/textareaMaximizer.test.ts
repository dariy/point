import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { must } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';
import type * as TextareaMaximizer from '../src/utils/textareaMaximizer.ts';

type Handler = (event: Partial<KeyboardEvent>) => void;

/** What document.createElement returns here: the buttons the maximizer adds. */
interface FakeEl {
  tag: string;
  className?: string;
  title?: string;
  classList: Set<string> & { toggle(c: string): boolean };
  style: Record<string, string>;
  dataset: Record<string, string>;
  listeners?: Record<string, Handler>;
  children?: FakeEl[];
  dispatched?: Event[];
  parentElement?: FakeParent | FakeEl;
  parentNode?: { children?: FakeEl[]; insertBefore?(newNode: FakeEl): void };
  addEventListener(type: string, handler: Handler): void;
  appendChild(child: FakeEl): void;
  insertBefore(newNode: FakeEl): void;
  remove(): void;
  dispatchEvent(event: Event): void;
}

/** The element that holds the textarea and receives the buttons. */
interface FakeParent {
  style: Record<string, string>;
  children: FakeEl[];
  appendChild(child: FakeEl): void;
  parentNode?: { insertBefore(newNode: FakeEl): void };
}

interface FakeTextarea {
  tagName: 'TEXTAREA';
  dataset: Record<string, string>;
  classList: { toggle(c: string): boolean | void; add(): void; contains(c: string): boolean };
  listeners?: Record<string, Handler>;
  addEventListener(type: string, handler: Handler): void;
  dispatchEvent(event: Event): void;
  parentElement: FakeParent;
}

/** The one boundary cast: these hand fakes stand in for the DOM types the maximizer is written against. */
const asDom = <T>(fake: object) => fake as unknown as T;

/** The handler a fake registered for `type`. */
const listener = (el: { listeners?: Record<string, Handler> }, type: string) =>
  must(el.listeners?.[type], `${type} listener`);

describe('textareaMaximizer', () => {
  let setupTextareaMaximizer: typeof TextareaMaximizer.setupTextareaMaximizer;

  before(async () => {
    // Basic DOM Mocks
    global.window = mock<typeof window>({
      getComputedStyle: () => mock<CSSStyleDeclaration>({ position: 'static' })
    });
    global.document = mock<Document>({
      createElement: (tag: string) => {
        const el: FakeEl = {
          tag,
          classList: Object.assign(new Set<string>(), {
            toggle: (c: string) => {
              if (el.classList.has(c)) {
                el.classList.delete(c);
                return false;
              } else {
                el.classList.add(c);
                return true;
              }
            },
          }),
          style: {},
          dataset: {},
          addEventListener: (event, handler) => {
            el.listeners = el.listeners || {};
            el.listeners[event] = handler;
          },
          appendChild: (child) => {
            el.children = el.children || [];
            el.children.push(child);
            child.parentElement = el;
            child.parentNode = el;
          },
          insertBefore: (newNode) => {
            el.children = el.children || [];
            el.children.push(newNode);
            newNode.parentNode = el;
          },
          remove: () => {
            if (el.parentNode && el.parentNode.children) {
              el.parentNode.children = el.parentNode.children.filter(c => c !== el);
            }
          },
          dispatchEvent: (event) => {
            el.dispatched = el.dispatched || [];
            el.dispatched.push(event);
          }
        };
        return asDom<HTMLElement>(el);
      },
      body: mock<HTMLElement>({
        classList: mock<DOMTokenList>({
          add: () => {},
          remove: () => {}
        }),
        // The maximizer locks page scrolling through utils/scrollLock.ts, which
        // writes document.body.style.overflow — without a style bag the lock is
        // silently skipped and this suite would stop covering it.
        style: mock<CSSStyleDeclaration>({}),
        appendChild: <T extends Node>(node: T) => node
      })
    });

    const mod = await import('../src/utils/textareaMaximizer.ts');
    setupTextareaMaximizer = mod.setupTextareaMaximizer;
  });

  test('should add maximize button to textarea', () => {
    let isMaximized = false;
    const textarea: FakeTextarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: () => {
          isMaximized = !isMaximized;
          return isMaximized;
        },
        add: () => {},
        contains: () => isMaximized
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: () => {},
      parentElement: {
        style: {},
        children: [],
        appendChild: (child) => {
          textarea.parentElement.children.push(child);
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = asDom<HTMLElement>({
      querySelectorAll: () => [textarea]
    });

    setupTextareaMaximizer(container);

    assert.strictEqual(textarea.dataset.maximizerSetup, 'true');
    assert.strictEqual(textarea.parentElement.children.length, 2, 'Two buttons should be added (maximize and save)');
    assert.strictEqual(textarea.parentElement.children[0].className, 'textarea-maximize-btn');
    assert.strictEqual(textarea.parentElement.children[1].className, 'textarea-save-btn');
  });

  test('should toggle maximized state on button click', () => {
    let maximized = false;
    const textarea: FakeTextarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: () => {
          maximized = !maximized;
          return maximized;
        },
        add: () => {},
        contains: () => maximized
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: () => {},
      parentElement: {
        style: {},
        children: [],
        appendChild: (child) => {
          textarea.parentElement.children.push(child);
          child.parentElement = textarea.parentElement;
        },
        // Grandparent node — toggleMaximize reparents the textarea's container
        // to document.body and leaves a placeholder behind via insertBefore.
        parentNode: {
          insertBefore: (newNode) => {
            newNode.parentNode = textarea.parentElement.parentNode;
          }
        }
      }
    };

    const container = asDom<HTMLElement>({
      querySelectorAll: () => [textarea]
    });

    setupTextareaMaximizer(container);

    const btn = textarea.parentElement.children[0];
    const saveBtn = textarea.parentElement.children[1];
    
    listener(btn, 'click')({ preventDefault: () => {}, stopPropagation: () => {} });

    assert.strictEqual(maximized, true, 'Textarea should be maximized');
    assert.strictEqual(btn.title, 'Minimize');
    assert.ok(saveBtn.classList.has('is-maximized'), 'Save button should be marked as maximized');
    assert.strictEqual(document.body.style.overflow, 'hidden', 'page scrolling is locked behind it');

    listener(btn, 'click')({ preventDefault: () => {}, stopPropagation: () => {} });
    assert.strictEqual(maximized, false, 'Textarea should be minimized');
    assert.strictEqual(btn.title, 'Maximize');
    assert.ok(!saveBtn.classList.has('is-maximized'), 'Save button should not be marked as maximized');
    assert.strictEqual(document.body.style.overflow, '', 'and released again');
  });

  test('should dispatch save event on save button click', () => {
    const events: Event[] = [];
    const textarea: FakeTextarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: () => {},
        add: () => {},
        contains: () => false
      },
      addEventListener: () => {},
      dispatchEvent: (e) => { events.push(e); },
      parentElement: {
        style: {},
        children: [],
        appendChild: (child) => {
          textarea.parentElement.children.push(child);
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = asDom<HTMLElement>({
      querySelectorAll: () => [textarea]
    });

    setupTextareaMaximizer(container);

    const saveBtn = textarea.parentElement.children[1];
    listener(saveBtn, 'click')({ preventDefault: () => {}, stopPropagation: () => {} });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'textarea:save');
    assert.strictEqual(events[0].bubbles, true);
  });

  test('should dispatch save event on Ctrl+S', () => {
    const events: Event[] = [];
    const textarea: FakeTextarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: () => {},
        add: () => {},
        contains: () => false
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: (e) => { events.push(e); },
      parentElement: {
        style: {},
        children: [],
        appendChild: (child) => {
          textarea.parentElement.children.push(child);
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = asDom<HTMLElement>({
      querySelectorAll: () => [textarea]
    });

    setupTextareaMaximizer(container);

    listener(textarea, 'keydown')({ 
      ctrlKey: true, 
      key: 's', 
      preventDefault: () => {} 
    });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'textarea:save');
  });
});
