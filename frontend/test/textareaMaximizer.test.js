import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('textareaMaximizer', () => {
  let setupTextareaMaximizer;

  before(async () => {
    // Basic DOM Mocks
    global.window = {
      getComputedStyle: () => ({ position: 'static' })
    };
    global.document = {
      createElement: (tag) => {
        const el = {
          tag,
          classList: new Set(),
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
          },
          dispatchEvent: (event) => {
            el.dispatched = el.dispatched || [];
            el.dispatched.push(event);
          }
        };
        el.classList.add = (c) => {
          const set = el.classList;
          Set.prototype.add.call(set, c);
        };
        el.classList.toggle = (c) => {
          if (el.classList.has(c)) {
            el.classList.delete(c);
            return false;
          } else {
            el.classList.add(c);
            return true;
          }
        };
        return el;
      },
      body: {
        classList: {
          add: () => {},
          remove: () => {}
        }
      }
    };

    const mod = await import('../src/utils/textareaMaximizer.js');
    setupTextareaMaximizer = mod.setupTextareaMaximizer;
  });

  test('should add maximize button to textarea', () => {
    const textarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: (c) => {
          textarea.isMaximized = !textarea.isMaximized;
          return textarea.isMaximized;
        },
        add: () => {},
        contains: (c) => textarea.isMaximized
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: () => {},
      parentElement: {
        style: {},
        appendChild: (child) => {
          textarea.parentElement.child = child;
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = {
      querySelectorAll: () => [textarea]
    };

    setupTextareaMaximizer(container);

    assert.strictEqual(textarea.dataset.maximizerSetup, 'true');
    assert.ok(textarea.parentElement.child, 'Maximize button should be added to parent');
    assert.strictEqual(textarea.parentElement.child.className, 'textarea-maximize-btn');
  });

  test('should toggle maximized state on button click', () => {
    let maximized = false;
    const textarea = {
      tagName: 'TEXTAREA',
      dataset: {},
      classList: {
        toggle: (c) => {
          maximized = !maximized;
          return maximized;
        },
        add: () => {},
        contains: (c) => maximized
      },
      addEventListener: (event, handler) => {
        textarea.listeners = textarea.listeners || {};
        textarea.listeners[event] = handler;
      },
      dispatchEvent: () => {},
      parentElement: {
        style: {},
        appendChild: (child) => {
          textarea.parentElement.child = child;
          child.parentElement = textarea.parentElement;
        }
      }
    };

    const container = {
      querySelectorAll: () => [textarea]
    };

    setupTextareaMaximizer(container);

    const btn = textarea.parentElement.child;
    btn.listeners.click({ preventDefault: () => {}, stopPropagation: () => {} });

    assert.strictEqual(maximized, true, 'Textarea should be maximized');
    assert.strictEqual(btn.title, 'Minimize');

    btn.listeners.click({ preventDefault: () => {}, stopPropagation: () => {} });
    assert.strictEqual(maximized, false, 'Textarea should be minimized');
    assert.strictEqual(btn.title, 'Maximize');
  });
});
